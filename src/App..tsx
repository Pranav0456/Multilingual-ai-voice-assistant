/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { Mic, MicOff, Send, Volume2, RotateCcw, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
type Language = 'en-US' | 'hi-IN' | 'mr-IN';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

const LANGUAGES: { label: string; value: Language; flag: string }[] = [
  { label: 'English', value: 'en-US', flag: '🇺🇸' },
  { label: 'Hindi', value: 'hi-IN', flag: '🇮🇳' },
  { label: 'Marathi', value: 'mr-IN', flag: '🇮🇳' },
];

// --- Speech Recognition Setup ---
// @ts-ignore
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export default function App() {
  // --- State ---
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('lumina_chat_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
      } catch (e) {
        console.error("Failed to parse chat history", e);
        return [];
      }
    }
    return [];
  });
  const [selectedLang, setSelectedLang] = useState<Language>(() => {
    return (localStorage.getItem('lumina_selected_lang') as Language) || 'en-US';
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Refs ---
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);

  const SILENCE_TIMEOUT = 3000; // 3 seconds of silence to auto-stop

  // --- Save to LocalStorage ---
  useEffect(() => {
    localStorage.setItem('lumina_chat_history', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem('lumina_selected_lang', selectedLang);
  }, [selectedLang]);

  // --- Load Voices ---
  useEffect(() => {
    const loadVoices = () => {
      const availableVoices = synthRef.current.getVoices();
      setVoices(availableVoices);
      
      // Auto-select a default voice for the current language if none selected
      if (!selectedVoice) {
        const defaultVoice = availableVoices.find(v => v.lang.startsWith(selectedLang.split('-')[0]));
        if (defaultVoice) setSelectedVoice(defaultVoice);
      }
    };

    loadVoices();
    if (synthRef.current.onvoiceschanged !== undefined) {
      synthRef.current.onvoiceschanged = loadVoices;
    }
  }, [selectedLang, selectedVoice]);

  // --- Filtered Voices for current language ---
  const filteredVoices = voices.filter(v => v.lang.startsWith(selectedLang.split('-')[0]));

  // --- Scroll to bottom ---
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, transcript]);

  // --- Initialize Speech Recognition ---
  useEffect(() => {
    if (!SpeechRecognition) {
      setError("Speech recognition is not supported in this browser. Please try Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = selectedLang;

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (recognitionRef.current) {
          console.log('Auto-stopping due to silence');
          recognitionRef.current.stop();
        }
      }, SILENCE_TIMEOUT);
    };

    recognition.onstart = () => {
      setIsListening(true);
      resetSilenceTimer();
    };
    recognition.onend = () => {
      setIsListening(false);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (event.error !== 'no-speech') {
        setError(`Speech error: ${event.error}`);
        setIsListening(false);
      }
    };

    recognition.onresult = (event: any) => {
      resetSilenceTimer();
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      setTranscript(finalTranscript || interimTranscript);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, [selectedLang]);

  // --- Handle Language Change ---
  const handleLanguageChange = (lang: Language) => {
    setSelectedLang(lang);
    setSelectedVoice(null); // Reset voice to auto-select for new language
    if (isListening) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current?.stop();
    }
  };

  // --- Toggle Listening ---
  const toggleListening = () => {
    if (isListening) {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current?.stop();
      if (transcript.trim()) {
        handleSendMessage(transcript);
      }
    } else {
      setError(null);
      setTranscript('');
      // Stop any current speech
      synthRef.current.cancel();
      setIsSpeaking(false);
      
      try {
        recognitionRef.current?.start();
      } catch (e) {
        console.error("Failed to start recognition", e);
      }
    }
  };

  // --- AI Response Generation ---
  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setTranscript('');
    setIsProcessing(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `The user is speaking in ${selectedLang}. Respond naturally in the same language. User says: ${text}`,
        config: {
          systemInstruction: `You are Lumina, a helpful and friendly multilingual AI voice assistant. 
          Keep your responses concise and conversational, suitable for being read aloud. 
          Always respond in the language the user is using (${selectedLang}).`,
        }
      });

      const aiText = response.text || "I'm sorry, I couldn't process that.";

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: aiText,
        sender: 'ai',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, aiMessage]);
      speak(aiText);
    } catch (err) {
      console.error("Gemini API Error:", err);
      setError("Failed to get AI response. Please check your connection.");
    } finally {
      setIsProcessing(false);
    }
  };

  // --- Text to Speech ---
  const speak = (text: string) => {
    if (!synthRef.current) return;

    // Cancel any ongoing speech
    synthRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = selectedLang;
    
    // Use the selected voice if available, otherwise fallback to finding one
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    } else {
      const voices = synthRef.current.getVoices();
      const voice = voices.find(v => v.lang.startsWith(selectedLang.split('-')[0]));
      if (voice) utterance.voice = voice;
    }

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    synthRef.current.speak(utterance);
  };

  const stopSpeaking = () => {
    synthRef.current.cancel();
    setIsSpeaking(false);
  };

  const clearChat = () => {
    if (window.confirm("Are you sure you want to clear the conversation history?")) {
      setMessages([]);
      localStorage.removeItem('lumina_chat_history');
      setError(null);
      stopSpeaking();
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-white font-sans selection:bg-emerald-500/30">
      {/* Background Gradients */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full" />
      </div>

      <div className="relative max-w-2xl mx-auto min-h-screen flex flex-col p-4 md:p-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8 pt-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Sparkles className="text-white w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Lumina AI</h1>
              <p className="text-xs text-zinc-500 font-medium uppercase tracking-widest">Voice Assistant</p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-2 bg-zinc-900/50 border border-zinc-800 p-1 rounded-full">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => handleLanguageChange(lang.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 flex items-center gap-1.5 ${
                    selectedLang === lang.value 
                      ? 'bg-emerald-500 text-white shadow-md' 
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                  }`}
                >
                  <span>{lang.flag}</span>
                  <span className="hidden sm:inline">{lang.label}</span>
                </button>
              ))}
            </div>

            {filteredVoices.length > 0 && (
              <div className="flex items-center gap-2">
                <Volume2 className="w-3.5 h-3.5 text-zinc-500" />
                <select
                  value={selectedVoice?.name || ''}
                  onChange={(e) => {
                    const voice = filteredVoices.find(v => v.name === e.target.value);
                    if (voice) setSelectedVoice(voice);
                  }}
                  className="bg-zinc-900/50 border border-zinc-800 text-[10px] text-zinc-400 rounded-lg px-2 py-1 outline-none hover:border-zinc-700 transition-colors cursor-pointer max-w-[150px] truncate"
                >
                  {filteredVoices.map((voice) => (
                    <option key={voice.name} value={voice.name}>
                      {voice.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </header>

        {/* Chat Area */}
        <main className="flex-1 overflow-y-auto mb-6 space-y-6 pr-2 custom-scrollbar">
          {messages.length === 0 && !transcript && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50 py-20">
              <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center mb-2">
                <Mic className="text-zinc-500 w-8 h-8" />
              </div>
              <h2 className="text-lg font-medium">How can I help you today?</h2>
              <p className="text-sm max-w-xs">Tap the microphone and start speaking in {LANGUAGES.find(l => l.value === selectedLang)?.label}.</p>
            </div>
          )}

          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div 
                  className={`max-w-[85%] p-4 rounded-2xl ${
                    msg.sender === 'user' 
                      ? 'bg-emerald-600 text-white rounded-tr-none' 
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-tl-none'
                  }`}
                >
                  <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                  <div className={`text-[10px] mt-2 opacity-50 ${msg.sender === 'user' ? 'text-right' : 'text-left'}`}>
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Interim Transcript */}
          {transcript && (
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }}
              className="flex justify-end"
            >
              <div className="max-w-[85%] p-4 rounded-2xl bg-emerald-600/20 border border-emerald-500/30 text-emerald-100 italic rounded-tr-none">
                <p className="text-[15px] leading-relaxed">{transcript}...</p>
              </div>
            </motion.div>
          )}

          {isProcessing && (
            <div className="flex justify-start">
              <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-2xl rounded-tl-none flex items-center gap-2">
                <div className="flex gap-1">
                  <motion.div 
                    animate={{ scale: [1, 1.5, 1] }} 
                    transition={{ repeat: Infinity, duration: 1 }}
                    className="w-1.5 h-1.5 bg-emerald-500 rounded-full" 
                  />
                  <motion.div 
                    animate={{ scale: [1, 1.5, 1] }} 
                    transition={{ repeat: Infinity, duration: 1, delay: 0.2 }}
                    className="w-1.5 h-1.5 bg-emerald-500 rounded-full" 
                  />
                  <motion.div 
                    animate={{ scale: [1, 1.5, 1] }} 
                    transition={{ repeat: Infinity, duration: 1, delay: 0.4 }}
                    className="w-1.5 h-1.5 bg-emerald-500 rounded-full" 
                  />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </main>

        {/* Error Display */}
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg text-center"
          >
            {error}
          </motion.div>
        )}

        {/* Controls */}
        <footer className="relative pb-8">
          <div className="flex flex-col items-center gap-6">
            
            {/* Visualizer / Status */}
            <div className="h-8 flex items-center justify-center">
              {isListening ? (
                <div className="flex items-center gap-1.5">
                  {[...Array(5)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ height: [8, 24, 8] }}
                      transition={{ 
                        repeat: Infinity, 
                        duration: 0.5, 
                        delay: i * 0.1,
                        ease: "easeInOut"
                      }}
                      className="w-1 bg-emerald-500 rounded-full"
                    />
                  ))}
                  <span className="ml-2 text-xs font-medium text-emerald-500 uppercase tracking-widest">Listening</span>
                </div>
              ) : isSpeaking ? (
                <button 
                  onClick={stopSpeaking}
                  className="flex items-center gap-2 text-xs font-medium text-blue-400 uppercase tracking-widest hover:text-blue-300 transition-colors"
                >
                  <Volume2 className="w-4 h-4 animate-pulse" />
                  <span>AI Speaking... Tap to stop</span>
                </button>
              ) : (
                <span className="text-xs font-medium text-zinc-500 uppercase tracking-widest">Ready</span>
              )}
            </div>

            {/* Main Action Buttons */}
            <div className="flex items-center gap-8">
              <button 
                onClick={clearChat}
                className="p-3 text-zinc-500 hover:text-white hover:bg-zinc-900 rounded-full transition-all"
                title="Clear conversation"
              >
                <RotateCcw className="w-6 h-6" />
              </button>

              <div className="relative">
                <AnimatePresence>
                  {isListening && (
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1.5, opacity: 0.2 }}
                      exit={{ scale: 0.8, opacity: 0 }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="absolute inset-0 bg-emerald-500 rounded-full"
                    />
                  )}
                </AnimatePresence>
                
                <button
                  onClick={toggleListening}
                  disabled={isProcessing}
                  className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-2xl ${
                    isListening 
                      ? 'bg-red-500 shadow-red-500/40' 
                      : 'bg-emerald-500 shadow-emerald-500/40 hover:scale-105 active:scale-95'
                  } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isListening ? (
                    <MicOff className="w-8 h-8 text-white" />
                  ) : (
                    <Mic className="w-8 h-8 text-white" />
                  )}
                </button>
              </div>

              <button 
                onClick={() => transcript && handleSendMessage(transcript)}
                disabled={!transcript || isProcessing}
                className={`p-3 rounded-full transition-all ${
                  transcript && !isProcessing 
                    ? 'text-emerald-500 hover:bg-emerald-500/10' 
                    : 'text-zinc-700 cursor-not-allowed'
                }`}
                title="Send message"
              >
                <Send className="w-6 h-6" />
              </button>
            </div>

            {/* Credits */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1 }}
              className="mt-6 flex flex-col items-center gap-1.5"
            >
              <span className="text-[9px] text-zinc-600 uppercase tracking-[0.3em] font-black">Crafted with ❤️ by</span>
              <motion.div
                animate={{ 
                  y: [0, -4, 0],
                  scale: [1, 1.05, 1],
                }}
                transition={{ 
                  duration: 4, 
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                className="relative group"
              >
                <motion.span 
                  animate={{ 
                    backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
                  }}
                  transition={{ 
                    duration: 5, 
                    repeat: Infinity,
                    ease: "linear"
                  }}
                  style={{
                    backgroundImage: 'linear-gradient(to right, #10b981, #3b82f6, #8b5cf6, #ec4899, #10b981)',
                    backgroundSize: '200% auto',
                  }}
                  className="text-base font-black tracking-tight bg-clip-text text-transparent drop-shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                >
                  Pranav Deshmukh
                </motion.span>
                <div className="absolute -inset-x-4 -bottom-1 h-px bg-gradient-to-right from-transparent via-emerald-500/50 to-transparent scale-x-0 group-hover:scale-x-100 transition-transform duration-500" />
              </motion.div>
            </motion.div>
          </div>
        </footer>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}
