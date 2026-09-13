import { BACKEND_URL } from "@/lib/config";
import axios from "axios";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Bot, Loader2, PhoneOff, User } from "lucide-react";
import { Button } from "./ui/button";
import { VoiceOrb } from "./VoiceOrb";

type Status = "connecting" | "live" | "ending";

function createLevelMeter(
    ctx: AudioContext,
    stream: MediaStream
) {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();

    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);

    return () => {
        analyser.getByteTimeDomainData(data);

        let sum = 0;

        for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
        }

        const rms = Math.sqrt(sum / data.length);

        return Math.min(1, rms * 3.2);
    };
}


export function Interview() {
    const { interviewId } = useParams();
    const navigate = useNavigate();

    const [status, setStatus] =
        useState<Status>("connecting");

    const [aiLevel, setAiLevel] = useState(0);
    const [userLevel, setUserLevel] = useState(0);

    const socketRef = useRef<WebSocket | null>(null);
    const recorderRef =
        useRef<MediaRecorder | null>(null);

    const userStreamRef =
        useRef<MediaStream | null>(null);

    const audioCtxRef =
        useRef<AudioContext | null>(null);

    const rafRef = useRef<number | null>(null);

    const aiSpeakingRef = useRef(false);
    const lastTranscriptRef = useRef("");

    const cancelledRef = useRef(false);


    // ----------------------------------------
    // AI SPEECH
    // ----------------------------------------

    function speak(text: string) {
        if (!text) return;

        window.speechSynthesis.cancel();

        const utterance =
            new SpeechSynthesisUtterance(text);

        utterance.lang = "en-US";
        utterance.rate = 0.95;
        utterance.pitch = 1;

        utterance.onstart = () => {
            aiSpeakingRef.current = true;
            setAiLevel(0.5);

            try {
                recorderRef.current?.pause();
            } catch {}
        };

        utterance.onend = () => {
            aiSpeakingRef.current = false;
            setAiLevel(0);

            try {
                recorderRef.current?.resume();
            } catch {}
        };

        utterance.onerror = () => {
            aiSpeakingRef.current = false;
            setAiLevel(0);

            try {
                recorderRef.current?.resume();
            } catch {}
        };

        window.speechSynthesis.speak(utterance);
    }


    // ----------------------------------------
    // START INTERVIEW
    // ----------------------------------------

    async function startInterview() {
        if (!interviewId) {
            throw new Error("Interview ID missing");
        }

        const response = await axios.post(
            `${BACKEND_URL}/api/v1/session/${interviewId}`,
            {}
        );

        const firstQuestion = response.data?.message;

        if (!firstQuestion) {
            throw new Error(
                "Backend did not return first question"
            );
        }

        console.log(
            "AI:",
            firstQuestion
        );

        speak(firstQuestion);
    }


    // ----------------------------------------
    // SEND USER ANSWER
    // ----------------------------------------

    async function sendTranscript(
        transcript: string
    ) {
        if (!interviewId) return;

        const cleanText = transcript.trim();

        if (!cleanText) return;

        // Ignore duplicate transcript
        if (
            cleanText.toLowerCase() ===
            lastTranscriptRef.current.toLowerCase()
        ) {
            return;
        }

        lastTranscriptRef.current = cleanText;

        console.log(
            "User:",
            cleanText
        );

        try {
            const response = await axios.post(
                `${BACKEND_URL}/api/v1/session/user/response/${interviewId}`,
                {
                    message: cleanText,
                }
            );

            const nextQuestion =
                response.data?.message;

            if (nextQuestion) {
                console.log(
                    "AI:",
                    nextQuestion
                );

                speak(nextQuestion);
            }
        } catch (error) {
            console.error(
                "Failed to send transcript:",
                error
            );
        }
    }


    // ----------------------------------------
    // MAIN SETUP
    // ----------------------------------------

    useEffect(() => {
        cancelledRef.current = false;

        let userMeter:
            (() => number) | null = null;

        async function setup() {
            try {
                if (!interviewId) {
                    throw new Error(
                        "Interview ID missing"
                    );
                }

                // Microphone
                const stream =
                    await navigator.mediaDevices.getUserMedia(
                        {
                            audio: true,
                        }
                    );

                if (cancelledRef.current) {
                    stream
                        .getTracks()
                        .forEach((track) =>
                            track.stop()
                        );

                    return;
                }

                userStreamRef.current = stream;


                // Audio analyser
                const audioCtx =
                    new AudioContext();

                audioCtxRef.current =
                    audioCtx;

                userMeter =
                    createLevelMeter(
                        audioCtx,
                        stream
                    );


                // --------------------------------
                // DEEPGRAM
                // --------------------------------

                // IMPORTANT:
                // Replace this with your NEW Deepgram key.
                const deepgramKey =
                    "d6ffdd46d013235f6ae9d402fe13f185a6f6f589";

                if (
                    !deepgramKey ||
                    deepgramKey ===
                        "YOUR_NEW_DEEPGRAM_API_KEY"
                ) {
                    throw new Error(
                        "Add your new Deepgram API key"
                    );
                }

                const socket =
                    new WebSocket(
                        "wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&smart_format=true&interim_results=true",
                        [
                            "token",
                            deepgramKey,
                        ]
                    );

                socketRef.current =
                    socket;


                socket.onopen = () => {
                    console.log(
                        "Deepgram connected"
                    );

                    try {
                        const recorder =
                            new MediaRecorder(
                                stream,
                                {
                                    mimeType:
                                        "audio/webm",
                                }
                            );

                        recorderRef.current =
                            recorder;

                        recorder.ondataavailable =
                            (event) => {
                                if (
                                    event.data.size >
                                        0 &&
                                    socket.readyState ===
                                        WebSocket.OPEN
                                ) {
                                    socket.send(
                                        event.data
                                    );
                                }
                            };

                        recorder.start(250);

                        console.log(
                            "Microphone recording started"
                        );
                    } catch (error) {
                        console.error(
                            "MediaRecorder error:",
                            error
                        );
                    }
                };


                socket.onmessage = (event) => {
                    try {
                        // Don't process user's mic
                        // while AI is speaking
                        if (
                            aiSpeakingRef.current
                        ) {
                            return;
                        }

                        const received =
                            JSON.parse(
                                event.data
                            );

                        const transcript =
                            received
                                .channel
                                ?.alternatives?.[0]
                                ?.transcript;

                        if (
                            !transcript ||
                            !transcript.trim()
                        ) {
                            return;
                        }


                        // Only send final utterances
                        const isFinal =
                            received.is_final ===
                                true ||
                            received.speech_final ===
                                true;

                        if (!isFinal) {
                            return;
                        }

                        sendTranscript(
                            transcript
                        );
                    } catch (error) {
                        console.error(
                            "Deepgram message error:",
                            error
                        );
                    }
                };


                socket.onerror = (
                    error
                ) => {
                    console.error(
                        "Deepgram error:",
                        error
                    );
                };


                socket.onclose = (
                    event
                ) => {
                    console.log(
                        "Deepgram closed:",
                        event.code,
                        event.reason
                    );
                };


                // --------------------------------
                // LIVE
                // --------------------------------

                setStatus("live");

                // Start AI interview
                await startInterview();


                // --------------------------------
                // LEVEL METER
                // --------------------------------

                const tick = () => {
                    if (userMeter) {
                        setUserLevel(
                            userMeter()
                        );
                    }

                    if (
                        !aiSpeakingRef.current
                    ) {
                        setAiLevel(0);
                    }

                    rafRef.current =
                        requestAnimationFrame(
                            tick
                        );
                };

                rafRef.current =
                    requestAnimationFrame(
                        tick
                    );

            } catch (error) {
                console.error(
                    "Interview setup failed:",
                    error
                );

                if (
                    !cancelledRef.current
                ) {
                    setStatus("ending");
                }
            }
        }

        setup();

        return () => {
            cancelledRef.current = true;

            cleanup();
        };
    }, [interviewId]);


    // ----------------------------------------
    // CLEANUP
    // ----------------------------------------

    function cleanup() {
        window.speechSynthesis.cancel();

        if (rafRef.current) {
            cancelAnimationFrame(
                rafRef.current
            );

            rafRef.current = null;
        }

        if (
            recorderRef.current &&
            recorderRef.current.state !==
                "inactive"
        ) {
            try {
                recorderRef.current.stop();
            } catch {}
        }

        recorderRef.current = null;

        socketRef.current?.close();

        socketRef.current = null;

        userStreamRef.current
            ?.getTracks()
            .forEach((track) =>
                track.stop()
            );

        userStreamRef.current = null;

        audioCtxRef.current
            ?.close()
            .catch(() => {});

        audioCtxRef.current = null;
    }


    // ----------------------------------------
    // END INTERVIEW
    // ----------------------------------------

    function endInterview() {
        setStatus("ending");

        cleanup();

        navigate(
            `/result/${interviewId}`
        );
    }


    const aiSpeaking =
        aiLevel > 0.06;

    const userSpeaking =
        userLevel > 0.06 &&
        !aiSpeaking;


    return (
        <main className="flex h-screen w-screen flex-col overflow-hidden">

            <header className="flex items-center justify-between px-6 py-5">

                <div className="flex items-center gap-2 text-sm font-medium">

                    <span className="relative flex size-2.5">

                        <span
                            className={
                                status ===
                                "live"
                                    ? "absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
                                    : "hidden"
                            }
                        />

                        <span
                            className={
                                "relative inline-flex size-2.5 rounded-full " +
                                (status ===
                                "live"
                                    ? "bg-emerald-400"
                                    : "bg-amber-400")
                            }
                        />

                    </span>

                    {status ===
                    "connecting"
                        ? "Connecting…"
                        : status ===
                          "ending"
                        ? "Wrapping up…"
                        : "Interview live"}

                </div>


                <span className="text-sm text-muted-foreground">
                    AI Interview
                </span>

            </header>


            <div className="flex flex-1 items-center justify-center px-6">

                {status ===
                "connecting" ? (

                    <div className="flex flex-col items-center gap-3 text-muted-foreground">

                        <Loader2 className="size-7 animate-spin" />

                        <p className="text-sm">
                            Setting up your interview & microphone…
                        </p>

                    </div>

                ) : (

                    <div className="flex w-full max-w-3xl items-center justify-center gap-12 sm:gap-24">

                        <VoiceOrb
                            level={aiLevel}
                            speaking={
                                aiSpeaking
                            }
                            label="Interviewer"
                            sublabel={
                                aiSpeaking
                                    ? "Speaking"
                                    : "Waiting"
                            }
                            icon={Bot}
                            accent="violet"
                        />


                        <VoiceOrb
                            level={
                                userLevel
                            }
                            speaking={
                                userSpeaking
                            }
                            label="You"
                            sublabel="Mic on"
                            icon={User}
                            accent="emerald"
                        />

                    </div>
                )}

            </div>


            <footer className="flex justify-center px-6 py-8">

                <Button
                    variant="destructive"
                    size="lg"
                    onClick={
                        endInterview
                    }
                    disabled={
                        status ===
                        "ending"
                    }
                    className="gap-2 rounded-full px-6"
                >

                    {status ===
                    "ending" ? (

                        <Loader2 className="size-4 animate-spin" />

                    ) : (

                        <PhoneOff className="size-4" />

                    )}

                    End interview

                </Button>

            </footer>

        </main>
    );
}