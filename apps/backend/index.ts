import express from "express";
import { PreInterviewBody } from "./types";
import { scrapeGithub } from "./scrapers/github";
import cors from "cors";
import { prisma } from "./db";
import { calculateResult } from "./result";

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.text({ type: ["text/plain"] }));

// ------------------------------------
// Gemini helper
// ------------------------------------
async function askGemini(prompt: string) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is missing");
    }

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [
                            {
                                text: prompt,
                            },
                        ],
                    },
                ],
            }),
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Gemini error:", errorText);
        throw new Error("Gemini API request failed");
    }

    const data = await response.json();

    return (
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Sorry, I could not generate a question."
    );
}

// ------------------------------------
// Create interview
// ------------------------------------
app.post("/api/v1/pre-interview", async (req, res) => {
    try {
        const { success, data } = PreInterviewBody.safeParse(req.body);

        if (!success) {
            res.status(411).json({
                message: "Incorrect body",
            });
            return;
        }

        const githubUrl = data.github.endsWith("/")
            ? data.github.slice(0, -1)
            : data.github;

        const githubUsername = githubUrl.split("/").pop()!;

        const githubData = await scrapeGithub(githubUsername);

        const interview = await prisma.interview.create({
            data: {
                githubMetadata: githubData,
                status: "Pre",
            },
        });

        res.json({
            id: interview.id,
        });
    } catch (error) {
        console.error("Pre-interview error:", error);

        res.status(500).json({
            message: "Failed to create interview",
        });
    }
});

// ------------------------------------
// Start interview
// ------------------------------------
app.post("/api/v1/session/:interviewId", async (req, res) => {
    try {
        const interview = await prisma.interview.findUnique({
            where: {
                id: req.params.interviewId,
            },
        });

        if (!interview) {
            res.status(404).json({
                message: "Interview not found",
            });
            return;
        }

        const githubData = interview.githubMetadata;

        const firstQuestion = await askGemini(`
You are a professional AI technical interviewer.

Start a technical job interview.

Candidate GitHub information:
${JSON.stringify(githubData)}

Rules:
- Ask only ONE question.
- Keep it short and clear.
- Start with a friendly introduction.
- Ask about the candidate's experience or one project.
- Do not provide multiple questions.
- Do not give the answer.

Return only the interviewer's spoken message.
`);

        await prisma.message.create({
            data: {
                interviewId: interview.id,
                type: "Assistant",
                message: firstQuestion,
            },
        });

        await prisma.interview.update({
            where: {
                id: interview.id,
            },
            data: {
                status: "InProgress",
            },
        });

        res.json({
            message: firstQuestion,
        });
    } catch (error) {
        console.error("Interview start error:", error);

        res.status(500).json({
            message: "Failed to start interview",
        });
    }
});

// ------------------------------------
// User answer → Gemini → next question
// ------------------------------------
app.post(
    "/api/v1/session/user/response/:interviewId",
    async (req, res) => {
        try {
            const { message } = req.body;

            if (!message || !message.trim()) {
                res.status(400).json({
                    message: "Empty response",
                });
                return;
            }

            const interviewId = req.params.interviewId;

            await prisma.message.create({
                data: {
                    interviewId,
                    type: "User",
                    message,
                },
            });

            const conversation = await prisma.message.findMany({
                where: {
                    interviewId,
                },
                orderBy: {
                    createdAt: "asc",
                },
            });

            const conversationText = conversation
                .map((m) => `${m.type}: ${m.message}`)
                .join("\n");

            const nextQuestion = await askGemini(`
You are an AI technical interviewer.

Continue the interview based on the conversation below.

Conversation:
${conversationText}

Rules:
- Ask exactly ONE question.
- Ask a relevant follow-up question.
- Focus on technical skills, projects, problem solving, or experience.
- Do not ask multiple questions.
- Do not answer the question yourself.
- Keep the question natural and short.

Return only the next interviewer's message.
`);

            await prisma.message.create({
                data: {
                    interviewId,
                    type: "Assistant",
                    message: nextQuestion,
                },
            });

            res.json({
                message: nextQuestion,
            });
        } catch (error) {
            console.error("User response error:", error);

            res.status(500).json({
                message: "Failed to generate next question",
            });
        }
    }
);

// ------------------------------------
// Result
// ------------------------------------
app.get("/api/v1/result/:interviewId", async (req, res) => {
    try {
        const interview = await prisma.interview.findFirst({
            where: {
                id: req.params.interviewId,
            },
            include: {
                conversations: true,
            },
        });

        if (!interview) {
            res.status(404).json({
                message: "Interview not found",
            });
            return;
        }

        if (interview.status !== "Done") {
            const result = await calculateResult(
                interview.conversations
            );

            await prisma.interview.update({
                where: {
                    id: req.params.interviewId,
                },
                data: {
                    status: "Done",
                    feedback: result.feedback,
                    score: result.score,
                },
            });

            res.json({
                score: result.score,
                feedback: result.feedback,
                transcript: interview.conversations.map((c) => ({
                    type: c.type,
                    content: c.message,
                    createdAt: c.createdAt,
                })),
                status: "Done",
            });

            return;
        }

        res.json({
            score: interview.score,
            feedback: interview.feedback,
            transcript: interview.conversations.map((c) => ({
                type: c.type,
                content: c.message,
                createdAt: c.createdAt,
            })),
            status: interview.status,
        });
    } catch (error) {
    console.error("Result error:", error);

    res.status(500).json({
      message: "Failed to get result",
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
