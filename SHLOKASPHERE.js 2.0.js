/**
 * ===================================================================================
 * SHLOKASPHERE - A World-Class AI-Powered Chat Application
 * ===================================================================================
 * This file contains the complete, self-contained React application.
 * It is structured internally into logical sections for clarity and maintainability.
 *
 * --- File Structure ---
 * 1.  **Firebase Service Setup**: Initializes and exports Firebase auth and Firestore.
 * 2.  **API Service Setup**: Functions for calling external AI analysis APIs.
 * 3.  **Theme Management**: A React Context for persistent light/dark mode.
 * 4.  **Custom Hooks**: `useAuth` and `useMessages` encapsulate all state and side-effect logic.
 * 5.  **UI Components**: Reusable components like `MessageItem`, `Avatar`, `AnalyticsDashboard`, etc.
 * 6.  **Main App Component**: The top-level component that assembles the entire application.
 *
 */
import React, { useState, useEffect, useRef, useCallback, useReducer, memo, createContext, useContext } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp, updateDoc, query, orderBy, limit, getDocs, where, startAfter, doc, onSnapshot, getDoc, deleteDoc } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const CONSTANTS = {
  LOCAL_STORAGE_THEME_KEY: 'theme',
  LOCAL_STORAGE_LANGUAGE_KEY: 'language',
  LOCAL_STORAGE_MUSIC_VOLUME_KEY: 'shlokasphere_music_volume',
  LOCAL_STORAGE_MUSIC_MUTED_KEY: 'shlokasphere_music_muted',
};

// --- Firebase Service Setup ---
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Google sign-in error:", error);
    toast.error(`Sign-in failed: ${error.message}`);
  }
}

async function signOutUser() {
  await signOut(auth);
}

function subscribeToAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

async function sendMessageToFirestore(messageObj) {
  return await addDoc(collection(db, "messages"), messageObj);
}

// --- API Service Setup ---

// Simple session cache to avoid re-analyzing the same text, improving performance and reducing API costs.
const apiCache = {
  get: (key) => {
    try {
      const item = sessionStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      return null;
    }
  },
  set: (key, value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Cache is non-critical, so we can ignore storage errors (e.g., quota exceeded)
    }
  }
};

/**
 * A generic, cache-aware utility for making API calls.
 * @param {object} config - The configuration for the API call.
 * @param {string} config.endpoint - The API endpoint to call.
 * @param {object} config.body - The request body.
 * @param {string} [config.cacheKey] - The key for session caching.
 * @param {function} [config.processData] - A function to process the raw response data.
 * @param {*} [config.defaultValue] - The value to return on failure.
 * @returns {Promise<*>} The processed data or default value.
 */
async function apiCall({ endpoint, body, cacheKey, processData = (data) => data, defaultValue = null }) {
  if (cacheKey) {
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`API error for ${endpoint} with status ${response.status}`);
    const data = await response.json();
    const result = processData(data);
    if (cacheKey) {
      apiCache.set(cacheKey, result);
    }
    return result;
  } catch (err) {
    console.error(`API call to ${endpoint} failed:`, err);
    return defaultValue;
  }
}

/**
 * A generic utility for handling streaming API responses.
 * @param {object} config - The configuration for the API call.
 * @param {string} config.endpoint - The API endpoint to call.
 * @param {object} config.body - The request body.
 * @param {AbortSignal} config.signal - The AbortSignal to cancel the request.
 * @param {(chunk: string) => void} config.onChunk - Callback for each received text chunk.
 * @param {() => void} [config.onDone] - Callback for when the stream is finished.
 * @param {(error: Error) => void} config.onError - Callback for any errors.
 * @param {number} [config.timeout] - Timeout in milliseconds.
 */
async function apiStreamCall({ endpoint, body, signal: userSignal, onChunk, onDone, onError, timeout = 20000 }) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Stream timed out after ${timeout}ms`)), timeout);

  // If the user aborts, we also trigger our internal abort.
  const userAbortHandler = () => timeoutController.abort();
  userSignal?.addEventListener('abort', userAbortHandler);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutController.signal, // We pass our combined signal to fetch
    });

    clearTimeout(timeoutId); // Clear the timeout if fetch starts successfully

    if (!response.ok || !response.body) {
      throw new Error(`API stream error for ${endpoint} with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        onDone?.();
        break;
      }
      const chunkText = decoder.decode(value, { stream: true });
      onChunk(chunkText);
    }
  } catch (error) {
    clearTimeout(timeoutId);
    onError(error);
  } finally {
    // Always clean up the event listener to prevent memory leaks
    userSignal?.removeEventListener('abort', userAbortHandler);
  }
}

const analyzeSentiment = (text) => apiCall({
  endpoint: '/api/google-sentiment',
  body: { text },
  cacheKey: `sentiment:${text}`,
  defaultValue: null,
});

const analyzeEntities = (text) => apiCall({
  endpoint: '/api/google-entities',
  body: { text },
  cacheKey: `entities:${text}`,
  processData: (data) => data.entities || [],
  defaultValue: [],
});

const translateText = (text, target) => apiCall({
  endpoint: '/api/google-translate',
  body: { text, target },
  cacheKey: `translate:${target}:${text}`,
  processData: (data) => data.translation || "",
  defaultValue: "",
});

/**
 * A centralized utility to perform all AI analyses on a message and update it in Firestore.
 * @param {import('firebase/firestore').DocumentReference} docRef - The Firestore document reference for the message.
 * @param {string} text - The text of the message to analyze.
 * @param {string} currentLang - The current language code of the UI (e.g., 'en', 'hi').
 * @returns {Promise<boolean>} - A promise that resolves to true on success and false on failure.
 */
async function analyzeAndSaveMessageFeatures(docRef, text, currentLang) {
  try {
    // Translate the user's message into the *other* supported language for display.
    const translationTargetLang = currentLang === 'en' ? 'hi' : 'en';

    const [sentiment, entities, translation] = await Promise.all([
      analyzeSentiment(text),
      analyzeEntities(text),
      // Only call the translation API if there is text to translate.
      text.trim() ? translateText(text, translationTargetLang) : Promise.resolve("")
    ]);

    const updatePayload = {};
    if (sentiment) updatePayload.sentiment = sentiment; // sentiment is null on failure, so this is OK.
    if (entities && entities.length > 0) updatePayload.entities = entities; // Only update if we actually got entities.
    if (translation) updatePayload.translation = translation;

    if (Object.keys(updatePayload).length > 0) {
      await updateDoc(docRef, updatePayload);
    }
    return true;
  } catch (e) {
    console.error("Failed to update message with analysis:", e);
    return false;
  }
}

// --- Language (i18n) Management ---
const translations = {
  en: {
    // App
    appName: "SHLOKASPHERE",
    loadingApp: "Loading Application...",
    loggedInAs: "Logged in as:",
    signOut: "Sign out",
    welcomeTitle: "Welcome to the AI-Powered Chat Experience",
    welcomeSubtitle: "Sign in to begin your conversation.",
    signInWithGoogle: "Sign in with Google",
    // Chat
    loadMore: "Load More",
    loadingMore: "Loading...",
    loadingMessages: "Loading messages...",
    messagePlaceholder: "Type your message...",
    send: "Send",
    stop: "Stop",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    deleteConfirmation: "Are you sure you want to delete this message and its AI response? This action cannot be undone.",
    regenerate: "Regenerate",
    newMessages: "New Messages",
    // Analytics
    analyticsDashboard: "Analytics Dashboard",
    totalMessages: "Total Messages",
    uniqueUsers: "Unique Users",
    avgSentiment: "Avg. Sentiment Score",
    topEntities: "Top Entities",
    // Message Item
    translationLabel: "Translation:",
  },
  hi: {
    // App
    appName: "श्लोकस्फेयर",
    loadingApp: "एप्लिकेशन लोड हो रहा है...",
    loggedInAs: "के रूप में लॉग इन:",
    signOut: "साइन आउट",
    welcomeTitle: "एआई-संचालित चैट अनुभव में आपका स्वागत है",
    welcomeSubtitle: "अपनी बातचीत शुरू करने के लिए साइन इन करें।",
    signInWithGoogle: "Google से साइन इन करें",
    // Chat
    loadMore: "और लोड करें",
    loadingMore: "लोड हो रहा है...",
    loadingMessages: "संदेश लोड हो रहे हैं...",
    messagePlaceholder: "अपना संदेश लिखें...",
    send: "भेजें",
    stop: "रोकें",
    save: "सहेजें",
    cancel: "रद्द करें",
    delete: "हटाएं",
    deleteConfirmation: "क्या आप वाकई इस संदेश और इसकी AI प्रतिक्रिया को हटाना चाहते हैं? यह कार्रवाई पूर्ववत नहीं की जा सकती।",
    regenerate: "पुनः उत्पन्न करें",
    newMessages: "नए संदेश",
    // Analytics
    analyticsDashboard: "विश्लेषिकी डैशबोर्ड",
    totalMessages: "कुल संदेश",
    uniqueUsers: "अद्वितीय उपयोगकर्ता",
    avgSentiment: "औसत भावना स्कोर",
    topEntities: "शीर्ष इकाइयां",
    // Message Item
    translationLabel: "अनुवाद:",
  }
};

const LanguageContext = createContext();

const useTranslation = () => {
  const { language } = useContext(LanguageContext);
  return (key) => translations[language][key] || key;
};

// --- Theme Management ---
const ThemeContext = createContext();

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      const savedTheme = localStorage.getItem(CONSTANTS.LOCAL_STORAGE_THEME_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') {
        return savedTheme;
      }
    } catch (error) {
      console.warn("localStorage is not available. Using default theme.");
    }
    return 'light';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(CONSTANTS.LOCAL_STORAGE_THEME_KEY, theme);
    } catch (error) {
      console.warn("localStorage is not available. Theme will not be persisted.");
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    try {
      const savedLang = localStorage.getItem(CONSTANTS.LOCAL_STORAGE_LANGUAGE_KEY);
      if (savedLang === 'en' || savedLang === 'hi') {
        return savedLang;
      }
    } catch (error) {
      console.warn("localStorage is not available. Using default language.");
    }
    return 'en'; // Default language
  });

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(CONSTANTS.LOCAL_STORAGE_LANGUAGE_KEY, language);
    } catch (error) {
      console.warn("localStorage is not available. Language will not be persisted.");
    }
  }, [language]);

  const value = { language, setLanguage };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

// --- Hooks ---

function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeToAuth((currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  return { user, loading };
}

const generateId = () => `temp_${Math.random().toString(36).substr(2, 9)}`;

function moderateContent(text) {
  const bannedWords = ['badword1', 'badword2'];
  return bannedWords.some(word => text.includes(word));
}

const actionTypes = {
  SET_LOADING: 'SET_LOADING',
  SET_LOADING_MORE: 'SET_LOADING_MORE',
  SET_TYPING: 'SET_TYPING',
  INITIAL_LOAD: 'INITIAL_LOAD',
  LOAD_MORE: 'LOAD_MORE',
  ADD_OPTIMISTIC: 'ADD_OPTIMISTIC',
  REMOVE_OPTIMISTIC: 'REMOVE_OPTIMISTIC',
  REALTIME_ADDED: 'REALTIME_ADDED',
  REALTIME_MODIFIED: 'REALTIME_MODIFIED',
  DELETE_MESSAGES: 'DELETE_MESSAGES',
};

const messagesInitialState = {
  messages: [],
  isTyping: false,
  lastDoc: null,
  hasMore: true,
  isLoading: true,
  isLoadingMore: false,
};

function messagesReducer(state, action) {
  switch (action.type) {
    case actionTypes.SET_LOADING:
      return { ...state, isLoading: action.payload };
    case actionTypes.SET_LOADING_MORE:
      return { ...state, isLoadingMore: action.payload };
    case actionTypes.SET_TYPING:
      return { ...state, isTyping: action.payload };
    case actionTypes.INITIAL_LOAD:
      return {
        ...state,
        messages: action.payload.messages,
        lastDoc: action.payload.lastDoc,
        hasMore: action.payload.hasMore,
        isLoading: false,
      };
    case actionTypes.LOAD_MORE:
      return {
        ...state,
        messages: [...action.payload.messages, ...state.messages],
        lastDoc: action.payload.lastDoc,
        hasMore: action.payload.hasMore,
        isLoadingMore: false,
      };
    case actionTypes.ADD_OPTIMISTIC:
      return { ...state, messages: [...state.messages, action.payload] };
    case actionTypes.REMOVE_OPTIMISTIC:
      return { ...state, messages: state.messages.filter(m => m.id !== action.payload.nonce) };
    case actionTypes.REALTIME_ADDED: {
      const message = action.payload;
      const optimisticIndex = message.nonce ? state.messages.findIndex(m => m.id === message.nonce) : -1;
      if (optimisticIndex > -1) {
        const newMessages = [...state.messages];
        newMessages[optimisticIndex] = message;
        return { ...state, messages: newMessages };
      }
      if (state.messages.some(m => m.id === message.id)) {
        return state;
      }
      return { ...state, messages: [...state.messages, message] };
    }
    case actionTypes.REALTIME_MODIFIED: {
      const message = action.payload;
      return {
        ...state,
        messages: state.messages.map(m => m.id === message.id ? { ...m, ...message } : m)
      };
    }
    case actionTypes.DELETE_MESSAGES:
      return {
        ...state,
        messages: state.messages.filter(m => !action.payload.includes(m.id))
      };
    default:
      throw new Error(`Unhandled action type: ${action.type}`);
  }
}

const _streamAIResponse = async (aiDocRef, body, signal) => {
    let fullResponseText = '';
    await apiStreamCall({
      endpoint: '/api/generate-response',
      body,
      signal,
      onChunk: async (chunk) => {
        fullResponseText += chunk;
        // Update Firestore. The `onSnapshot` listener will update the UI.
        await updateDoc(aiDocRef, { text: fullResponseText });
      },
      onDone: async () => {
        // Final update with the total token count.
        const finalTokens = fullResponseText.split(/\s+/).length;
        await updateDoc(aiDocRef, { tokens: finalTokens });
      },
      onError: (error) => {
        throw error;
      }
    });
};

function useMessages(user) {
  const [state, dispatch] = useReducer(messagesReducer, messagesInitialState);
  const { messages, lastDoc, hasMore, isLoadingMore } = state;
  const { language } = useContext(LanguageContext);
  const [analyzingIds, setAnalyzingIds] = useState(new Set());

  const sessionStartRef = useRef(new Date());
  const messagesRef = useRef(messages);
  const aiResponseCount = useRef(0);
  const abortControllerRef = useRef(null);
  const langRef = useRef(language);
  const isMountedRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  
  // Keep a stable ref to the latest language value to avoid re-creating callbacks.
  useEffect(() => {
    langRef.current = language;
  }, [language]);

  // This effect tracks the mounted state of the component.
  useEffect(() => {
    isMountedRef.current = true;
    // Cleanup function to abort any ongoing AI generation when the component unmounts.
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    const loadInitialMessages = async () => {
      dispatch({ type: actionTypes.SET_LOADING, payload: true });
      try {
        const q = query(collection(db, "messages"), where("user", "==", user.email), orderBy("timestamp", "desc"), limit(20));
        const snapshot = await getDocs(q);
        if (!isMountedRef.current) return; // Prevent state update if component unmounted
        const initialMessages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), timestamp: doc.data().timestamp?.toDate() })).reverse();
        dispatch({
          type: actionTypes.INITIAL_LOAD,
          payload: {
            messages: initialMessages,
            lastDoc: snapshot.docs[snapshot.docs.length - 1],
            hasMore: snapshot.docs.length === 20,
          }
        });
      } catch (error) {
        console.error("Error loading initial messages:", error);
        toast.error("Could not load chat history.");
      } finally {
        // Ensure we don't try to update state on an unmounted component.
        if (isMountedRef.current) { 
          dispatch({ type: actionTypes.SET_LOADING, payload: false });
        }
      }
    };

    loadInitialMessages();

    const qRealtime = query(collection(db, "messages"), where("user", "==", user.email), where("timestamp", ">=", sessionStartRef.current));
    const unsubscribe = onSnapshot(qRealtime, (snapshot) => {
      snapshot.docChanges().forEach(change => {
        const changedDoc = { id: change.doc.id, ...change.doc.data(), timestamp: change.doc.data().timestamp?.toDate() };
        if (change.type === "added") {
          dispatch({ type: actionTypes.REALTIME_ADDED, payload: changedDoc });
        }
        if (change.type === "modified") {
          dispatch({ type: actionTypes.REALTIME_MODIFIED, payload: changedDoc });
        }
      });
    }, (error) => {
      console.error("Real-time listener failed:", error);
      toast.error("Lost connection to the server. Please refresh.");
      // In a more complex app, you might dispatch an error state here.
    });

    return () => {
      unsubscribe();
    };
  }, [user]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore) return;
    dispatch({ type: actionTypes.SET_LOADING_MORE, payload: true });
    try {
      const q = query(collection(db, "messages"), where("user", "==", user.email), orderBy("timestamp", "desc"), startAfter(lastDoc), limit(20));
      const snapshot = await getDocs(q);
      if (!isMountedRef.current) return;
      const olderMessages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), timestamp: doc.data().timestamp?.toDate() })).reverse();
      dispatch({
        type: actionTypes.LOAD_MORE,
        payload: {
          messages: olderMessages,
          lastDoc: snapshot.docs[snapshot.docs.length - 1],
          hasMore: snapshot.docs.length === 20,
        }
      });
    } catch (error) {
      console.error("Error loading more messages:", error);
      toast.error("Could not load older messages.");
    } finally {
      // Always reset the loading state, even if an error occurs.
      if (isMountedRef.current) {
        dispatch({ type: actionTypes.SET_LOADING_MORE, payload: false });
      }
    }
  }, [lastDoc, hasMore, isLoadingMore]);

  const performMessageAnalysis = useCallback(async (messageId, text, options = {}) => {
    const { showToast = true } = options;

    if (!messageId || !text) return;
    if (messageId.startsWith('temp_')) {
      if (showToast) toast.error("Please wait for the message to be saved before analyzing.");
      return;
    }

    setAnalyzingIds(prev => new Set(prev).add(messageId));
    if (showToast) toast.loading('Analyzing message...', { id: `analyzing-${messageId}` });

    try {
      const messageRef = doc(db, "messages", messageId);
      const success = await analyzeAndSaveMessageFeatures(messageRef, text, langRef.current);
      if (showToast) {
        if (success) {
          toast.success('Analysis complete!', { id: `analyzing-${messageId}` });
        } else {
          toast.error('Analysis failed.', { id: `analyzing-${messageId}` });
        }
      }
    } catch (error) {
      console.error("Failed to re-analyze message:", error);
      if (showToast) toast.error('Analysis failed.', { id: `analyzing-${messageId}` });
    } finally {
      setAnalyzingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(messageId);
        return newSet;
      });
    }
  }, []); // This callback is now stable.

  const _startAIGeneration = useCallback(() => {
    dispatch({ type: actionTypes.SET_TYPING, payload: true });
    aiResponseCount.current++;
    abortControllerRef.current = new AbortController();
    return abortControllerRef.current.signal;
  }, []);

  const _endAIGeneration = useCallback(() => {
    aiResponseCount.current--;
    if (aiResponseCount.current === 0 && isMountedRef.current) {
      dispatch({ type: actionTypes.SET_TYPING, payload: false });
    }
    abortControllerRef.current = null;
  }, []);

  const _handleAbortError = useCallback(async (aiDocRef) => {
    console.log('AI generation was stopped by the user.');
    if (aiDocRef) {
      try {
        const finalDoc = await getDoc(aiDocRef);
        const existingText = finalDoc.data()?.text || '';
        // Avoid adding multiple "stopped" messages if the user spams the button
        if (!existingText.includes("[Generation stopped by user]")) {
          await updateDoc(aiDocRef, { text: existingText + "\n\n[Generation stopped by user]" });
        }
      } catch (e) {
        console.error("Error updating message after abort:", e);
      }
    }
  }, []);

  const deleteMessage = useCallback(async (messageId) => {
    const messageIndex = messagesRef.current.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      toast.error("Could not find the message to delete.");
      return;
    }

    const messageToDelete = messagesRef.current[messageIndex];
    const nextMessage = messagesRef.current[messageIndex + 1];

    const idsToDelete = [messageToDelete.id];
    if (nextMessage && nextMessage.sender === 'ai') {
      idsToDelete.push(nextMessage.id);
    }

    // Optimistically update the UI
    dispatch({ type: actionTypes.DELETE_MESSAGES, payload: idsToDelete });

    try {
      // Delete documents from Firestore
      const deletePromises = idsToDelete.map(id => deleteDoc(doc(db, "messages", id)));
      await Promise.all(deletePromises);
      toast.success("Message deleted.");
    } catch (error) {
      console.error("Error deleting message(s):", error);
      toast.error("Failed to delete message.");
      // In a real-world scenario, you might want to add logic here to revert
      // the optimistic update by re-fetching the messages. For this app,
      // a page refresh would be the user's recourse.
    }
  }, []);

  const editMessage = useCallback(async (messageId, newText) => {
    const signal = _startAIGeneration();
    let aiDocRef;
    try {
      // 1. Find the message and the subsequent AI response
      const messageIndex = messagesRef.current.findIndex(m => m.id === messageId);
      if (messageIndex === -1) {
        throw new Error("Could not find the message to edit.");
      }

      const nextMessage = messagesRef.current[messageIndex + 1];
      if (!nextMessage || nextMessage.sender !== 'ai') {
        throw new Error("Can only edit messages that have an AI response.");
      }
      const aiMessageToUpdateId = nextMessage.id;
      aiDocRef = doc(db, "messages", aiMessageToUpdateId);

      // 2. Update user message in Firestore
      const userMessageRef = doc(db, "messages", messageId);
      await updateDoc(userMessageRef, {
        text: newText,
        tokens: newText.split(/\s+/).length,
        editedAt: serverTimestamp(),
      });

      // 3. Re-run analysis on the edited text. This can run in parallel.
      performMessageAnalysis(messageId, newText, { showToast: false });

      // 4. Re-generate AI response, updating the existing AI message
      await updateDoc(aiDocRef, { text: '...', tokens: 1 }); // Clear old response

      const historyForEdit = messagesRef.current.slice(0, messageIndex);
      await _streamAIResponse(aiDocRef, { message: newText, history: historyForEdit, language: langRef.current }, signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        await _handleAbortError(aiDocRef);
      } else {
        console.error("Error re-generating AI response:", error);
        toast.error("The AI failed to respond to the edit.");
        if (aiDocRef) {
          await updateDoc(aiDocRef, { text: "[Error generating new response]" });
        }
      }
    } finally {
      _endAIGeneration();
    }
  }, [_startAIGeneration, _endAIGeneration, performMessageAnalysis, _handleAbortError]);

  const regenerateResponse = useCallback(async (aiMessageId) => {
    // 1. Find the AI message and the preceding user message
    const messageIndex = messagesRef.current.findIndex(m => m.id === aiMessageId);
    if (messageIndex < 1) { // Needs a message before it
      toast.error("Cannot regenerate this response.");
      return;
    }

    const userMessage = messagesRef.current[messageIndex - 1];
    if (userMessage.sender !== 'user') {
      toast.error("Cannot regenerate a response that does not follow a user message.");
      return;
    }

    // 3. Re-generate AI response, updating the existing AI message
    const signal = _startAIGeneration();
    const aiDocRef = doc(db, "messages", aiMessageId);

    try {
      await updateDoc(aiDocRef, { text: '...', tokens: 1 }); // Clear old response
      const historyForRegen = messagesRef.current.slice(0, messageIndex - 1);
      await _streamAIResponse(aiDocRef, { message: userMessage.text, history: historyForRegen, language: langRef.current }, signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        await _handleAbortError(aiDocRef);
      } else {
        console.error("Error re-generating AI response:", error);
        toast.error("The AI failed to regenerate the response.");
        await updateDoc(aiDocRef, { text: "[Error generating new response]" });
      }
    } finally {
      _endAIGeneration();
    }
  }, [_startAIGeneration, _endAIGeneration, _handleAbortError]);

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const sendMessage = useCallback(async (messageText) => {
    if (moderateContent(messageText)) {
      toast.error('Inappropriate content detected.');
      return;
    }

    const nonce = generateId();
    const optimisticMessage = { id: nonce, nonce, user: user.email, text: messageText, sender: 'user', timestamp: new Date(), tokens: messageText.split(/\s+/).length, sentiment: null, entities: [], translation: null };
    dispatch({ type: actionTypes.ADD_OPTIMISTIC, payload: optimisticMessage });
    
    let userDocRef;
    try {
      const messageForDb = { nonce, user: user.email, text: messageText, sender: 'user', timestamp: serverTimestamp(), tokens: messageText.split(/\s+/).length };
      userDocRef = await sendMessageToFirestore(messageForDb);
    } catch (error) {
      console.error("Error sending message:", error);
      toast.error("Could not send message.");
      if (isMountedRef.current) {
        dispatch({ type: actionTypes.REMOVE_OPTIMISTIC, payload: { nonce } });
      }
      return;
    }

    // This can run in parallel without blocking the AI response
    performMessageAnalysis(userDocRef.id, messageText, { showToast: false });

    // New streaming logic for AI response
    const fetchAIResponseStream = async () => {
      let aiDocRef;
      const signal = _startAIGeneration();

      try {
        // 1. Create an empty AI message in Firestore to get an ID.
        const aiMessageForDb = { user: user.email, text: '', sender: 'ai', timestamp: serverTimestamp(), tokens: 0 };
        aiDocRef = await sendMessageToFirestore(aiMessageForDb);

        await _streamAIResponse(aiDocRef, { message: messageText, history: messagesRef.current.slice(0, -1), language: langRef.current }, signal);

      } catch (error) {
        if (error.name === 'AbortError') {
          await _handleAbortError(aiDocRef);
          return; // Exit gracefully, finally block will still run.
        }
        console.error("Error getting AI response:", error);
        toast.error("The AI failed to respond. Please try again.");
        if (aiDocRef) {
          // Update the message to show an error if something went wrong during streaming.
          await updateDoc(aiDocRef, { text: "I'm sorry, I'm having trouble connecting right now." });
        }
      } finally {
        _endAIGeneration();
      }
    };

    fetchAIResponseStream();
  }, [user, performMessageAnalysis, _startAIGeneration, _endAIGeneration, _handleAbortError]); // Dependencies are now more stable.

  return { ...state, loadMore, sendMessage, stopGeneration, performMessageAnalysis, analyzingIds, editMessage, deleteMessage, regenerateResponse };
}

// --- UI Components ---

function AITypingIndicator() {
  return (
    <div className="flex my-2 gap-4 justify-start">
      {/* This visually hidden element makes the typing indicator accessible to screen readers. */}
      <div role="status" className="sr-only">
        AI is typing...
      </div>
      <div className="p-4 rounded-2xl shadow-md bg-gray-100 dark:bg-gray-600">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <span className="h-2 w-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
          <span className="h-2 w-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
          <span className="h-2 w-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"></span>
        </div>
      </div>
    </div>
  );
}

function MessageSkeleton({ sender = 'ai' }) {
  const isUser = sender === 'user';
  return (
    <div className={`flex items-start gap-3 animate-pulse ${isUser ? 'flex-row-reverse ml-auto' : 'mr-auto'}`}>
      <div className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-600 flex-shrink-0"></div>
      <div className="p-4 rounded-2xl bg-gray-200 dark:bg-gray-600 w-48">
        <div className="h-4 bg-gray-300 dark:bg-gray-500 rounded w-5/6 mb-2"></div>
        <div className="h-4 bg-gray-300 dark:bg-gray-500 rounded w-1/2"></div>
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="p-8 mt-8 bg-gray-50 dark:bg-gray-700/50 rounded-xl shadow-sm animate-pulse">
      <div className="h-8 bg-gray-200 dark:bg-gray-600 rounded w-3/4 mb-6"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-20 bg-gray-200 dark:bg-gray-600 rounded-lg"></div>
        <div className="h-20 bg-gray-200 dark:bg-gray-600 rounded-lg"></div>
        <div className="h-20 bg-gray-200 dark:bg-gray-600 rounded-lg"></div>
        <div className="h-20 bg-gray-200 dark:bg-gray-600 rounded-lg"></div>
      </div>
    </div>
  );
}

const CopyIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
);
const AnalyzeIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M12 21v-1m0-10a5 5 0 00-5 5h10a5 5 0 00-5-5z" /></svg>
);
const EditIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L15.232 5.232z" /></svg>
);
const DeleteIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
);
const RegenerateIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 110 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" /></svg>
);
const PlayIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
);
const PauseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h1a1 1 0 001-1V8a1 1 0 00-1-1H8zm3 0a1 1 0 00-1 1v4a1 1 0 001 1h1a1 1 0 001-1V8a1 1 0 00-1-1h-1z" clipRule="evenodd" /></svg>
);
const VolumeUpIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" /></svg>
);
const VolumeOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
);

const ThemeToggleButton = () => {
  const { theme, toggleTheme } = useContext(ThemeContext);
  return (
    <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300" title="Toggle theme">
      {theme === 'light' ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 18v-1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M12 12a5 5 0 100-10 5 5 0 000 10z" /></svg>
      )}
    </button>
  );
};

const LanguageSelector = () => {
  const { language, setLanguage } = useContext(LanguageContext);

  return (
    <div className="relative">
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        className="p-2 rounded-full appearance-none bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer focus:outline-none"
        aria-label="Select language"
      >
        <option value="en">🇺🇸 English</option>
        <option value="hi">🇮🇳 हिन्दी</option>
      </select>
    </div>
  );
};

function MusicPlayer() {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.2); // Start with a low, non-intrusive volume
  const [isMuted, setIsMuted] = useState(false);

  // IMPORTANT: Replace this with a URL to your actual audio file (e.g., an MP3 of Hindu chants/shlokas).
  const audioSrc = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; // Placeholder relaxing music

  // Load state from localStorage
  useEffect(() => {
    try {
      const savedVolume = localStorage.getItem(CONSTANTS.LOCAL_STORAGE_MUSIC_VOLUME_KEY);
      const savedIsMuted = localStorage.getItem(CONSTANTS.LOCAL_STORAGE_MUSIC_MUTED_KEY);
      // We don't auto-play on load to respect the user's environment.
      if (savedVolume !== null) {
        setVolume(parseFloat(savedVolume));
      }
      if (savedIsMuted !== null) {
        setIsMuted(savedIsMuted === 'true');
      }
    } catch (e) {
      console.warn("Could not access localStorage for music player state.");
    }
  }, []);

  // Save state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(CONSTANTS.LOCAL_STORAGE_MUSIC_VOLUME_KEY, volume);
      localStorage.setItem(CONSTANTS.LOCAL_STORAGE_MUSIC_MUTED_KEY, isMuted);
    } catch (e) {
      console.warn("Could not access localStorage for music player state.");
    }
  }, [volume, isMuted]);

  // Sync audio element with state
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = isMuted ? 0 : volume;
      if (isPlaying) {
        audio.play().catch(e => {
          // Autoplay is often blocked by browsers. We can ignore this error as the user can manually play.
          if (e.name !== 'NotAllowedError') {
            console.error("Audio play failed:", e);
          }
        });
      } else {
        audio.pause();
      }
    }
  }, [isPlaying, volume, isMuted]);

  const togglePlayPause = () => setIsPlaying(!isPlaying);
  const handleVolumeChange = (e) => { setIsMuted(false); setVolume(parseFloat(e.target.value)); };
  const toggleMute = () => setIsMuted(!isMuted);

  return (
    <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
      <audio ref={audioRef} src={audioSrc} loop />
      <button onClick={togglePlayPause} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title={isPlaying ? "Pause music" : "Play music"}>{isPlaying ? <PauseIcon /> : <PlayIcon />}</button>
      <button onClick={toggleMute} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title={isMuted ? "Unmute" : "Mute"}>{isMuted || volume === 0 ? <VolumeOffIcon /> : <VolumeUpIcon />}</button>
      <input type="range" min="0" max="1" step="0.01" value={isMuted ? 0 : volume} onChange={handleVolumeChange} className="w-20 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700" aria-label="Volume control" />
    </div>
  );
}

const Avatar = ({ sender, userEmail }) => {
  const isUser = sender === 'user';
  // Robustly get the first letter of the email, or 'U' as a fallback.
  const nameInitial = (userEmail || 'U').charAt(0).toUpperCase();
  const avatarSrc = isUser
    ? `https://ui-avatars.com/api/?name=${nameInitial}&background=ffc107&color=fff&bold=true`
    : `https://ui-avatars.com/api/?name=AI&background=4f46e5&color=fff&bold=true`;

  // Eager loading for small, critical images like avatars provides a better user experience.
  return <img src={avatarSrc} alt={`${sender} avatar`} className="h-8 w-8 rounded-full shadow-md flex-shrink-0" />;
};

// This object is defined once outside the component to prevent re-creation on every render.
const markdownComponents = {
  code({ node, inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <SyntaxHighlighter
        style={oneDark}
        language={match[1]}
        PreTag="div"
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      <code className={`${className} bg-gray-200 dark:bg-gray-700 rounded-md px-1 py-0.5`} {...props}>
        {children}
      </code>
    );
  }
};

function EditMessageForm({ message, onSave, onCancel, isTyping }) {
  const [editedText, setEditedText] = useState(message.text);
  const t = useTranslation();
  const textareaRef = useRef(null);

  useEffect(() => {
    // Auto-resize textarea and focus it
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, []);

  const handleTextChange = (e) => {
    setEditedText(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  };

  const handleSave = () => {
    if (editedText.trim() && editedText.trim() !== message.text) {
      onSave(message.id, editedText);
    } else {
      onCancel();
    }
  };

  return (
    <div className="w-full">
      <textarea ref={textareaRef} value={editedText} onChange={handleTextChange} className="w-full p-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 text-gray-800 dark:text-gray-100 disabled:bg-gray-100 dark:disabled:bg-gray-800/50" rows="1" disabled={isTyping} />
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-600 rounded-md disabled:opacity-50" disabled={isTyping}>{t('cancel')}</button>
        <button onClick={handleSave} className="px-3 py-1 text-sm bg-blue-500 text-white rounded-md disabled:opacity-50" disabled={isTyping}>{t('save')}</button>
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({ message, performMessageAnalysis, isAnalyzing, isTyping, canEdit, canDelete, canRegenerate, editingMessageId, setEditingMessageId, editMessage, deleteMessage, regenerateResponse }) {
  const t = useTranslation();
  const isUser = message.sender === 'user';
  // Check if analysis has run. An optimistic message won't have these properties.
  const isAnalyzed = message.hasOwnProperty('sentiment') && message.hasOwnProperty('entities');
  const isEditing = message.id === editingMessageId;

  const getAnalysisButtonTooltip = () => {
    if (isAnalyzed) return "Analysis complete";
    if (isAnalyzing) return "Analyzing...";
    return "Re-run analysis";
  };

  const getAnalysisButtonAriaLabel = () => {
    if (isAnalyzed) return "Analysis complete";
    if (isAnalyzing) return "Analyzing message";
    return "Re-run analysis on message";
  };

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) {
      toast.error('Clipboard access is not available in this browser.');
      return;
    }
    navigator.clipboard.writeText(message.text)
      .then(() => toast.success('Copied to clipboard!'))
      .catch(() => toast.error('Failed to copy.'));
  }, [message.text]);

  const handleAnalyze = useCallback(() => performMessageAnalysis(message.id, message.text), [performMessageAnalysis, message.id, message.text]);

  const handleEditSave = useCallback((messageId, newText) => {
    editMessage(messageId, newText);
    setEditingMessageId(null);
  }, [editMessage, setEditingMessageId]);

  const handleEditCancel = useCallback(() => {
    setEditingMessageId(null);
  }, [setEditingMessageId]);

  const handleDelete = useCallback(() => {
    if (window.confirm(t('deleteConfirmation'))) {
      deleteMessage(message.id);
    }
  }, [deleteMessage, message.id, t]);

  const handleRegenerate = useCallback(() => {
    regenerateResponse(message.id);
  }, [regenerateResponse, message.id]);

  if (isEditing) {
    return (
      <div className={`flex items-start my-2 gap-3 group max-w-[85%] w-full ${isUser ? 'flex-row-reverse ml-auto' : 'mr-auto'}`}>
        <Avatar sender={message.sender} userEmail={message.user} />
        <div className="p-4 rounded-2xl shadow-md bg-gray-100 dark:bg-gray-700 w-full"><EditMessageForm message={message} onSave={handleEditSave} onCancel={handleEditCancel} isTyping={isTyping} /></div>
      </div>
    );
  }

  return (
    <div
      className={`flex items-start my-2 gap-3 group max-w-[85%] ${isUser ? 'flex-row-reverse ml-auto' : 'mr-auto'}`}
      role="listitem"
    >
      <Avatar sender={message.sender} userEmail={message.user} />

      <div
        className={`relative p-4 rounded-2xl shadow-md text-gray-800 dark:text-gray-100 ${
          isUser
            ? 'bg-gradient-to-r from-yellow-400 to-pink-400 text-white'
            : 'bg-gray-100 dark:bg-gray-600'
        }`}
      >
        {/* Toolbar is now absolutely positioned relative to the message bubble for a cleaner layout. */}
        <div className={`absolute top-0 -translate-y-1/2 flex items-center gap-1 p-1 rounded-full bg-white dark:bg-gray-700 border dark:border-gray-600 shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-10 ${isUser ? 'left-2' : 'right-2'}`}>
          <button onClick={handleCopy} title="Copy text" aria-label="Copy message text" className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300">
            <CopyIcon />
          </button>
          {isUser && (
            <button
              onClick={handleAnalyze}
              title={getAnalysisButtonTooltip()}
              aria-label={getAnalysisButtonAriaLabel()}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:text-gray-300 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
              disabled={isAnalyzed || isAnalyzing}
            >
              <AnalyzeIcon />
            </button>
          )}
          {canEdit && (
            <button onClick={() => setEditingMessageId(message.id)} title="Edit message" aria-label="Edit message"
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 disabled:text-gray-300 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
              disabled={isTyping}>
              <EditIcon />
            </button>
          )}
          {canDelete && (
            <button onClick={handleDelete} title={t('delete')} aria-label={t('delete')}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-600 text-red-500 dark:text-red-400 disabled:text-gray-300 dark:disabled:text-gray-500 disabled:cursor-not-allowed"
              disabled={isTyping}>
              <DeleteIcon />
            </button>
          )}
          {canRegenerate && (
            <button onClick={handleRegenerate} title={t('regenerate')} aria-label={t('regenerate')}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300"
              disabled={isTyping}>
              <RegenerateIcon />
            </button>
          )}
        </div>
        {isUser ? (
          <p className="text-base leading-relaxed whitespace-pre-wrap font-medium">{message.text}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              components={markdownComponents}
              remarkPlugins={[remarkGfm]}
            >
              {message.text}
            </ReactMarkdown>
          </div>
        )}
        {message.tokens && (
          <div className={`text-xs mt-2 opacity-70 ${message.sender === 'user' ? 'text-white/80' : 'text-gray-500'}`}>
            {message.tokens} tokens • {message.timestamp instanceof Date && !isNaN(message.timestamp) && new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{message.editedAt && <span className="italic opacity-80 ml-1">• edited</span>}
          </div>
        )}
        {message.sentiment && (
          <div className="mt-2 text-xs">
            <span className="border border-yellow-300 dark:border-yellow-700 rounded-md px-2 py-0.5 bg-yellow-50 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300">Sentiment: {message.sentiment.score.toFixed(2)}</span>
          </div>
        )}
        {message.entities && message.entities.length > 0 && (
          <div className="mt-2 flex gap-2 flex-wrap text-xs">
            {message.entities.map((entity, idx) => (
              <span key={idx} className="border border-green-200 dark:border-green-700 rounded-md px-2 py-0.5 bg-green-50 dark:bg-green-900/50 text-green-800 dark:text-green-300">{entity.name} ({entity.type})</span>
            ))}
          </div>
        )}
        {message.translation && (
          <div className="mt-2 text-xs">
            <span className="border border-indigo-300 dark:border-indigo-700 rounded-md px-2 py-0.5 bg-indigo-50 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">{t('translationLabel')} {message.translation}</span>
          </div>
        )}
      </div>
    </div>
  );
});

function AnalyticsDashboard({ user }) {
  const t = useTranslation();
  const [stats, setStats] = useState({ totalMessages: 0, uniqueUsers: 0, averageSentiment: 'N/A', topEntities: [] });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    const fetchAnalyticsData = async () => {
      setIsLoading(true);
      try {
        const q = query(collection(db, "messages"), where("user", "==", user.email));
        const snapshot = await getDocs(q);
        const messages = snapshot.docs.map(doc => doc.data());

        if (messages.length === 0) {
          setStats({ totalMessages: 0, uniqueUsers: 0, averageSentiment: 'N/A', topEntities: [] });
          return;
        }

        const userMessagesWithSentiment = messages.filter(m => m.sender === 'user' && m.sentiment?.score);
        const totalMessages = messages.length;
        // Since we filter by user, uniqueUsers will be 1, but we can keep the logic for future expansion.
        const uniqueUsers = new Set(messages.map(m => m.user)).size;

        const totalSentimentScore = userMessagesWithSentiment.reduce((acc, msg) => acc + msg.sentiment.score, 0);
        const averageSentiment = userMessagesWithSentiment.length > 0 ? (totalSentimentScore / userMessagesWithSentiment.length).toFixed(2) : 'N/A';

        const entityCounts = messages
          .flatMap(m => m.entities || [])
          .reduce((acc, entity) => {
            acc[entity.name] = (acc[entity.name] || 0) + 1;
            return acc;
          }, {});

        const topEntities = Object.entries(entityCounts)
          .sort(([, countA], [, countB]) => countB - countA)
          .slice(0, 3)
          .map(([name]) => name);

        setStats({ totalMessages, uniqueUsers, averageSentiment, topEntities });
      } catch (error) {
        console.error("Failed to fetch analytics data:", error);
        toast.error("Could not load analytics data.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchAnalyticsData();
  }, [user]);

  if (isLoading) {
    return <AnalyticsSkeleton />;
  }

  return (
    <div className="p-8 mt-8 bg-gray-50 dark:bg-gray-700/50 rounded-xl shadow-sm">
      <h2 className="font-bold text-2xl text-gray-800 dark:text-gray-100">{t('analyticsDashboard')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 text-gray-700 dark:text-gray-300">
        <div className="p-4 bg-white/50 dark:bg-gray-800/50 rounded-lg">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('totalMessages')}</div>
          <div className="text-2xl font-bold">{stats.totalMessages}</div>
        </div>
        <div className="p-4 bg-white/50 dark:bg-gray-800/50 rounded-lg">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('uniqueUsers')}</div>
          <div className="text-2xl font-bold">{stats.uniqueUsers}</div>
        </div>
        <div className="p-4 bg-white/50 dark:bg-gray-800/50 rounded-lg">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('avgSentiment')}</div>
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{stats.averageSentiment}</div>
        </div>
        <div className="p-4 bg-white/50 dark:bg-gray-800/50 rounded-lg">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('topEntities')}</div>
          <div className="text-lg font-semibold truncate text-green-600 dark:text-green-400">
            {stats.topEntities.length > 0 ? stats.topEntities.join(', ') : 'N/A'}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatComponent({ user, messages, isTyping, isLoading, hasMore, isLoadingMore, loadMore, sendMessage, stopGeneration, performMessageAnalysis, analyzingIds, editMessage, deleteMessage, regenerateResponse }) {
  const t = useTranslation();
  const [inputMessage, setInputMessage] = useState('');
  const [editingMessageId, setEditingMessageId] = useState(null);
  const inputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const [scrollHeightBeforeLoad, setScrollHeightBeforeLoad] = useState(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isAtBottomRef = useRef(true);

  const scrollToBottom = (behavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
    setShowScrollToBottom(false);
  };

  useEffect(() => {
    if (scrollHeightBeforeLoad === null) { // Only applies to new messages
      if (isAtBottomRef.current) {
        scrollToBottom('smooth');
      } else {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.sender !== 'user') {
          setShowScrollToBottom(true);
        }
      }
    }
  }, [messages, isTyping, scrollHeightBeforeLoad]);

  React.useLayoutEffect(() => {
    // After loading more messages, restore the scroll position to prevent jumping.
    if (scrollHeightBeforeLoad !== null && scrollContainerRef.current) {
      const newScrollHeight = scrollContainerRef.current.scrollHeight;
      scrollContainerRef.current.scrollTop += (newScrollHeight - scrollHeightBeforeLoad);
      setScrollHeightBeforeLoad(null); // Reset after adjusting
    }
  }, [messages, scrollHeightBeforeLoad]);

  useEffect(() => {
    // Auto-focus the input field when the chat is ready.
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      isAtBottomRef.current = atBottom;
      if (atBottom && showScrollToBottom) {
        setShowScrollToBottom(false);
      }
    }
  }, [showScrollToBottom]);

  const handleLoadMore = () => {
    if (scrollContainerRef.current) {
      setScrollHeightBeforeLoad(scrollContainerRef.current.scrollHeight);
    }
    loadMore();
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;
    sendMessage(inputMessage);
    setInputMessage('');
    // Re-focus the input after sending for a smoother user experience.
    inputRef.current?.focus();
  };

  return (
    <div className="mt-6 relative">
      <div ref={scrollContainerRef} onScroll={handleScroll} className="h-[60vh] overflow-y-auto p-4 border rounded-lg bg-gray-50 dark:bg-gray-900/50 dark:border-gray-700 space-y-4" role="log" aria-live="polite" aria-label="Chat history">
        {isLoading ? (
          <div className="space-y-4">
            <MessageSkeleton />
            <MessageSkeleton sender="user" />
            <MessageSkeleton />
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="text-center">
                <button onClick={handleLoadMore} disabled={isLoadingMore} className="text-blue-500 hover:underline disabled:text-gray-400 dark:text-blue-400 dark:disabled:text-gray-500">
                  {isLoadingMore ? t('loadingMore') : t('loadMore')}
                </button>
              </div>
            )}
            {messages.map((message, index) => {
              const canEdit = message.sender === 'user' && messages[index + 1]?.sender === 'ai';
              const canDelete = message.sender === 'user';
              const canRegenerate = message.sender === 'ai' && index === messages.length - 1 && !isTyping;
              return <MessageItem
                key={message.id}
                message={message}
                performMessageAnalysis={performMessageAnalysis}
                isAnalyzing={analyzingIds.has(message.id)}
                isTyping={isTyping}
                canEdit={canEdit}
                canDelete={canDelete}
                canRegenerate={canRegenerate}
                editingMessageId={editingMessageId}
                setEditingMessageId={setEditingMessageId}
                editMessage={editMessage}
                deleteMessage={deleteMessage}
                regenerateResponse={regenerateResponse} />
            })}
          </>
        )}
        {isTyping && !isLoading && <AITypingIndicator />}
        <div ref={messagesEndRef} />
      </div>
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 px-4 py-2 bg-blue-500 text-white rounded-full shadow-lg flex items-center gap-2 text-sm animate-bounce"
          aria-label="Scroll to new messages"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
          {t('newMessages')}
        </button>
      )}

      <form onSubmit={handleSendMessage} className="mt-4 flex">
        <input ref={inputRef} type="text" value={inputMessage} onChange={(e) => setInputMessage(e.target.value)} className="flex-grow p-2 border rounded-l-md bg-white dark:bg-gray-800 dark:border-gray-600 text-gray-800 dark:text-gray-100 placeholder-gray-400" aria-label="Your message" placeholder={t('messagePlaceholder')} disabled={isTyping || !user} />
        {isTyping ? (
          <button
            type="button"
            onClick={stopGeneration}
            className="px-4 py-2 bg-red-500 text-white rounded-r-md flex items-center gap-2 hover:bg-red-600 transition-colors"
            aria-label="Stop generating response"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 5a1 1 0 011-1h8a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1V5z" clipRule="evenodd" /></svg>
            {t('stop')}
          </button>
        ) : (
          <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded-r-md hover:bg-blue-600 transition-colors" disabled={!user}>
            {t('send')}
          </button>
        )}
      </form>
    </div>
  );
}

// --- Error Boundary Component ---
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // You can also log the error to an error reporting service
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <div className="p-8 text-center text-red-500 dark:text-red-400"><h2 className="text-2xl font-bold">Something went wrong.</h2><p className="mt-2">Please try refreshing the page.</p></div>;
    }

    return this.props.children;
  }
}

// --- Main App Component ---
function App() {
  return (
    <LanguageProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </LanguageProvider>
  );
}

function AppContent() {
  const { user, loading: authLoading } = useAuth();
  const messageData = useMessages(user);
  const t = useTranslation();

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center text-gray-500 dark:text-gray-400">
        {t('loadingApp')}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex flex-col items-center p-4 font-sans">
      <Toaster position="top-center" />
      <div className="w-full max-w-3xl bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6">
        <ErrorBoundary>
          <h1 className="text-3xl font-bold mb-4 text-center text-gray-800 dark:text-gray-100">
            {t('appName')}
          </h1>
          {user ? (
            <div>
              <div className="flex items-center justify-between mb-4 border-b pb-4 dark:border-gray-700">
                <div className="text-sm text-gray-600 dark:text-gray-300 min-w-0">
                  {t('loggedInAs')} <span className="font-semibold truncate" title={user.email}>{user.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <MusicPlayer />
                  <LanguageSelector />
                  <ThemeToggleButton />
                  <button onClick={signOutUser} className="px-4 py-2 text-sm bg-red-500 text-white rounded-md shadow-md hover:bg-red-600 transition-colors">
                    {t('signOut')}
                  </button>
                </div>
              </div>
              <ChatComponent user={user} {...messageData} />
              <AnalyticsDashboard user={user} />
            </div>
          ) : (
            <div className="flex flex-col items-center text-center py-16">
              <h2 className="text-xl font-semibold mb-2 text-gray-700 dark:text-gray-200">
                {t('welcomeTitle')}
              </h2>
              <p className="mb-6 text-gray-500 dark:text-gray-400">
                {t('welcomeSubtitle')}
              </p>
              <button onClick={signInWithGoogle} className="px-6 py-3 text-lg bg-blue-500 text-white rounded-md shadow-md hover:bg-blue-600 transition-colors flex items-center gap-2">
                {t('signInWithGoogle')}
              </button>
            </div>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default App;
