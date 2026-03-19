import React, { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Stage, Layer, Line as KonvaLine } from 'react-konva';
import { io, Socket } from 'socket.io-client';
import { Line } from './types';
import { Eraser, Pencil, Trash2, Users, LogOut, Copy, Check, Plus, LogIn, AlertCircle, Save, Image as ImageIcon, Moon, Sun, Undo, Redo } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth, signIn, storage } from './firebase';
import { doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp, getDocFromServer } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import { onAuthStateChanged, User } from 'firebase/auth';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, errorInfo: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, errorInfo: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorInfo: error.message };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let displayMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.errorInfo);
        if (parsed.error) displayMessage = `Database Error: ${parsed.error}`;
      } catch (e) {
        displayMessage = this.state.errorInfo;
      }

      return (
        <div className="min-h-screen bg-paper dark:bg-dark-paper flex items-center justify-center p-4 font-serif transition-colors">
          <div className="bg-white dark:bg-dark-olive-light p-8 rounded-3xl shadow-xl w-full max-w-md border border-red-200 dark:border-red-900/30 text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-ink dark:text-dark-ink mb-2">Application Error</h2>
            <p className="text-olive dark:text-dark-olive mb-6">{displayMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-olive dark:bg-dark-olive text-white dark:text-dark-paper px-6 py-2 rounded-xl hover:bg-olive-dark dark:hover:bg-dark-olive-dark transition-colors"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const COLORS = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];
const STROKE_WIDTHS = [2, 5, 10, 15];

const generateRoomCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

function App() {
  const [roomCode, setRoomCode] = useState<string>('');
  const [isJoined, setIsJoined] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [tool, setTool] = useState('pencil');
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('theme') === 'dark';
    }
    return false;
  });
  const [color, setColor] = useState(darkMode ? '#FFFFFF' : '#000000');
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [copied, setCopied] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [savedImages, setSavedImages] = useState<any[]>([]);
  const [showGallery, setShowGallery] = useState(false);
  const [roomCreator, setRoomCreator] = useState<string | null>(null);
  const [redoStack, setRedoStack] = useState<Line[]>([]);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);
  
  const isDrawing = useRef(false);
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('initial-data', (data: Line[]) => {
      setLines(data);
    });

    newSocket.on('draw', (newLine: Line) => {
      setLines((prev) => [...prev, newLine]);
    });

    newSocket.on('clear', () => {
      setLines([]);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Sync with Firestore when room is joined
  useEffect(() => {
    if (!isJoined || !roomCode) return;

    const roomRef = doc(db, 'rooms', roomCode);
    const unsubscribe = onSnapshot(roomRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.lines) {
          setLines(data.lines);
        }
        if (data.savedImages) {
          setSavedImages(data.savedImages);
        }
        if (data.redoStack) {
          setRedoStack(data.redoStack);
        }
        if (data.createdBy) {
          setRoomCreator(data.createdBy);
        }
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `rooms/${roomCode}`);
    });

    return () => unsubscribe();
  }, [isJoined, roomCode]);

  useEffect(() => {
    if (!containerRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [isJoined]);

  const handleCreateRoom = async () => {
    if (!user) {
      await signIn();
      return;
    }
    const newCode = generateRoomCode();
    const roomRef = doc(db, 'rooms', newCode);
    try {
      await setDoc(roomRef, {
        roomCode: newCode,
        lines: [],
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `rooms/${newCode}`);
    }
    setRoomCode(newCode);
    if (socket) socket.emit('join-room', newCode);
    setIsJoined(true);
  };

  const handleJoinRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!roomCode.trim()) return;

    const roomRef = doc(db, 'rooms', roomCode);
    let docSnap;
    try {
      docSnap = await getDoc(roomRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `rooms/${roomCode}`);
    }

    if (docSnap && docSnap.exists()) {
      if (socket) socket.emit('join-room', roomCode);
      setIsJoined(true);
    } else {
      alert('Room not found!');
    }
  };

  const handleMouseDown = (e: any) => {
    if (!isJoined || !user) return;
    
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    
    // Determine if user is allowed to draw in this area
    const isCreator = user.uid === roomCreator;
    const isTopHalf = pos.y < dimensions.height / 2;
    
    if (isCreator && !isTopHalf) return;
    if (!isCreator && isTopHalf) return;

    isDrawing.current = true;
    const newLine: Line = {
      tool,
      points: [pos.x, pos.y],
      color: tool === 'eraser' ? (darkMode ? '#1A1A1A' : '#FFFFFF') : color,
      strokeWidth
    };
    setLines([...lines, newLine]);
  };

  const handleMouseMove = (e: any) => {
    if (!isDrawing.current || !isJoined || !user || !roomCode) return;
    const stage = e.target.getStage();
    const point = stage.getPointerPosition();
    
    const isCreator = user.uid === roomCreator;
    const midY = dimensions.height / 2;
    
    // Clamp Y coordinate to user's zone
    let clampedY = point.y;
    if (isCreator) {
      clampedY = Math.min(point.y, midY - 2); // Small buffer
    } else {
      clampedY = Math.max(point.y, midY + 2); // Small buffer
    }

    let currentLines = [...lines];
    let lastLine = { ...currentLines[currentLines.length - 1] };
    
    // If current segment is getting long, commit it and start a new one for granularity
    // 20 points = 10 (x,y) pairs
    if (lastLine.points.length >= 20) {
      // Commit the finished segment to Firestore
      const roomRef = doc(db, 'rooms', roomCode);
      updateDoc(roomRef, {
        lines: arrayUnion(lastLine),
        redoStack: []
      }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomCode}`));

      // Emit the finished segment
      if (socket) {
        socket.emit('draw', { roomCode, line: lastLine });
      }

      // Start new segment from the last point of the previous one to ensure continuity
      const newLine: Line = {
        tool,
        points: [lastLine.points[lastLine.points.length - 2], lastLine.points[lastLine.points.length - 1], point.x, clampedY],
        color: tool === 'eraser' ? (darkMode ? '#1A1A1A' : '#FFFFFF') : color,
        strokeWidth
      };
      setLines([...currentLines, newLine]);
    } else {
      lastLine.points = [...lastLine.points, point.x, clampedY];
      currentLines[currentLines.length - 1] = lastLine;
      setLines(currentLines);
    }
  };

  const handleMouseUp = async () => {
    if (!isDrawing.current || !roomCode) return;
    isDrawing.current = false;
    
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      
      // Only save if it has more than just the starting point
      if (lastLine.points.length > 2) {
        // Emit via socket for real-time
        if (socket) {
          socket.emit('draw', { roomCode, line: lastLine });
        }
        // Save to Firestore for persistence
        const roomRef = doc(db, 'rooms', roomCode);
        try {
          await updateDoc(roomRef, {
            lines: arrayUnion(lastLine),
            redoStack: [] // Clear redo stack on new action
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `rooms/${roomCode}`);
        }
      }
    }
  };

  const handleUndo = async () => {
    if (lines.length === 0 || !roomCode) return;
    
    const newLines = [...lines];
    const undoneLine = newLines.pop();
    if (!undoneLine) return;

    const roomRef = doc(db, 'rooms', roomCode);
    try {
      await updateDoc(roomRef, {
        lines: newLines,
        redoStack: arrayUnion(undoneLine)
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${roomCode}`);
    }
  };

  const handleRedo = async () => {
    if (redoStack.length === 0 || !roomCode) return;

    const newRedoStack = [...redoStack];
    const redoneLine = newRedoStack.pop();
    if (!redoneLine) return;

    const roomRef = doc(db, 'rooms', roomCode);
    try {
      await updateDoc(roomRef, {
        lines: arrayUnion(redoneLine),
        redoStack: newRedoStack
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${roomCode}`);
    }
  };

  const handleClear = async () => {
    if (socket) {
      socket.emit('clear', roomCode);
    }
    const roomRef = doc(db, 'rooms', roomCode);
    try {
      await updateDoc(roomRef, {
        lines: []
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `rooms/${roomCode}`);
    }
  };

  const handleSaveImage = async () => {
    if (!stageRef.current || !user || !roomCode) return;
    
    setIsSaving(true);
    try {
      const dataUrl = stageRef.current.toDataURL();
      const storageRef = ref(storage, `rooms/${roomCode}/snapshots/${Date.now()}.png`);
      
      await uploadString(storageRef, dataUrl, 'data_url');
      const downloadUrl = await getDownloadURL(storageRef);
      
      const roomRef = doc(db, 'rooms', roomCode);
      await updateDoc(roomRef, {
        savedImages: arrayUnion({
          url: downloadUrl,
          timestamp: new Date().toISOString(),
          savedBy: user.displayName || user.email || 'Anonymous'
        })
      });
      
      alert('Snapshot saved to room gallery!');
    } catch (error) {
      console.error('Error saving image:', error);
      alert('Failed to save snapshot.');
    } finally {
      setIsSaving(false);
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-paper dark:bg-dark-paper flex items-center justify-center font-serif transition-colors">
        <div className="animate-pulse text-olive dark:text-dark-olive">Loading...</div>
      </div>
    );
  }

  if (!isJoined) {
    return (
      <div className="min-h-screen bg-paper dark:bg-dark-paper flex items-center justify-center p-4 font-serif transition-colors">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-dark-olive-light p-8 rounded-3xl shadow-xl w-full max-w-md border border-olive/10 dark:border-dark-olive/10"
        >
          <div className="flex justify-between items-start mb-6">
            <div className="w-16 h-16 bg-olive dark:bg-dark-olive rounded-full flex items-center justify-center text-white dark:text-dark-paper">
              <Pencil size={32} />
            </div>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-full text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
          <h1 className="text-3xl font-bold text-center text-ink dark:text-dark-ink mb-2">DualDraw</h1>
          <p className="text-center text-olive dark:text-dark-olive mb-8 italic">Collaborative canvas for two</p>
          
          {!user ? (
            <button
              onClick={signIn}
              className="w-full bg-olive dark:bg-dark-olive text-white dark:text-dark-paper py-3 rounded-xl font-semibold hover:bg-olive-dark dark:hover:bg-dark-olive-dark transition-colors flex items-center justify-center gap-2 mb-4"
            >
              <LogIn size={20} />
              Sign in with Google
            </button>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-col gap-3">
                <button
                  onClick={handleCreateRoom}
                  className="w-full bg-olive dark:bg-dark-olive text-white dark:text-dark-paper py-4 rounded-xl font-semibold hover:bg-olive-dark dark:hover:bg-dark-olive-dark transition-all flex items-center justify-center gap-2 shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
                >
                  <Plus size={24} />
                  Create New Room
                </button>
                
                <div className="relative flex items-center py-2">
                  <div className="flex-grow border-t border-olive/10 dark:border-dark-olive/10"></div>
                  <span className="flex-shrink mx-4 text-olive/40 dark:text-dark-olive/40 text-xs uppercase tracking-widest">or</span>
                  <div className="flex-grow border-t border-olive/10 dark:border-dark-olive/10"></div>
                </div>

                <form onSubmit={handleJoinRoom} className="space-y-3">
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                    placeholder="ENTER ROOM CODE"
                    className="w-full px-4 py-3 rounded-xl border border-olive/20 dark:border-dark-olive/20 bg-white dark:bg-dark-paper text-ink dark:text-dark-ink focus:ring-2 focus:ring-olive dark:focus:ring-dark-olive focus:border-transparent outline-none transition-all font-mono text-center tracking-widest"
                  />
                  <button
                    type="submit"
                    className="w-full bg-white dark:bg-dark-paper text-olive dark:text-dark-olive border-2 border-olive dark:border-dark-olive py-3 rounded-xl font-semibold hover:bg-paper dark:hover:bg-dark-olive-light transition-colors flex items-center justify-center gap-2"
                  >
                    <Users size={20} />
                    Join Existing Room
                  </button>
                </form>
              </div>
              
              <div className="text-center">
                <p className="text-xs text-olive/60 dark:text-dark-olive/60">Signed in as {user.displayName}</p>
                <button onClick={() => auth.signOut()} className="text-[10px] text-red-600 uppercase tracking-widest mt-1 hover:underline">Sign Out</button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-paper dark:bg-dark-paper flex flex-col font-serif overflow-hidden transition-colors">
      {/* Header */}
      <header className="bg-white dark:bg-dark-olive-light border-b border-olive/10 dark:border-dark-olive/10 px-6 py-3 flex items-center justify-between shadow-sm z-10 transition-colors">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-ink dark:text-dark-ink">DualDraw</h1>
          <div className="h-6 w-px bg-olive/20 dark:bg-dark-olive/20" />
          <div className="flex items-center gap-2 bg-paper dark:bg-dark-paper px-3 py-1 rounded-full border border-olive/10 dark:border-dark-olive/10">
            <span className="text-xs uppercase tracking-widest text-olive dark:text-dark-olive font-semibold">Room:</span>
            <span className="font-mono text-sm font-bold text-ink dark:text-dark-ink">{roomCode}</span>
            <button 
              onClick={copyRoomCode}
              className="p-1 hover:bg-white dark:hover:bg-dark-olive-light rounded-full transition-colors text-olive dark:text-dark-olive"
            >
              {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 rounded-full text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all"
            title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {darkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button 
            onClick={() => setIsJoined(false)}
            className="flex items-center gap-2 text-olive dark:text-dark-olive hover:text-red-600 transition-colors text-sm font-semibold uppercase tracking-wider"
          >
            <LogOut size={18} />
            Leave
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Toolbar */}
        <aside className="w-20 bg-white dark:bg-dark-olive-light border-r border-olive/10 dark:border-dark-olive/10 flex flex-col items-center py-6 gap-8 shadow-sm z-10 transition-colors">
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setTool('pencil')}
              className={`p-3 rounded-2xl transition-all ${tool === 'pencil' ? 'bg-olive dark:bg-dark-olive text-white dark:text-dark-paper shadow-lg' : 'text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper'}`}
              title="Pencil"
            >
              <Pencil size={24} />
            </button>
            <button
              onClick={() => setTool('eraser')}
              className={`p-3 rounded-2xl transition-all ${tool === 'eraser' ? 'bg-olive dark:bg-dark-olive text-white dark:text-dark-paper shadow-lg' : 'text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper'}`}
              title="Eraser"
            >
              <Eraser size={24} />
            </button>
          </div>

          <div className="h-px w-8 bg-olive/10 dark:bg-dark-olive/10" />

          <div className="flex flex-col gap-3">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => {
                  setColor(c);
                  setTool('pencil');
                }}
                className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${color === c && tool === 'pencil' ? 'border-olive dark:border-dark-olive scale-125' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="h-px w-8 bg-olive/10 dark:bg-dark-olive/10" />

          <div className="flex flex-col gap-4">
            {STROKE_WIDTHS.map((w) => (
              <button
                key={w}
                onClick={() => setStrokeWidth(w)}
                className="flex items-center justify-center"
              >
                <div 
                  className={`rounded-full transition-all ${strokeWidth === w ? 'bg-olive dark:bg-dark-olive' : 'bg-olive/30 dark:bg-dark-olive/30'}`}
                  style={{ width: w + 4, height: w + 4 }}
                />
              </button>
            ))}
          </div>

          <div className="mt-auto flex flex-col gap-2">
            <div className="flex flex-col gap-2 mb-2">
              <button
                onClick={handleUndo}
                disabled={lines.length === 0}
                className={`p-3 rounded-2xl text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all ${lines.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
                title="Undo"
              >
                <Undo size={24} />
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                className={`p-3 rounded-2xl text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all ${redoStack.length === 0 ? 'opacity-30 cursor-not-allowed' : ''}`}
                title="Redo"
              >
                <Redo size={24} />
              </button>
            </div>
            <div className="h-px w-8 bg-olive/10 dark:bg-dark-olive/10 mx-auto mb-2" />
            <button
              onClick={() => setShowGallery(true)}
              className="p-3 rounded-2xl text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all relative"
              title="View Gallery"
            >
              <ImageIcon size={24} />
              {savedImages.length > 0 && (
                <span className="absolute top-2 right-2 w-4 h-4 bg-red-500 text-white text-[8px] rounded-full flex items-center justify-center">
                  {savedImages.length}
                </span>
              )}
            </button>
            <button
              onClick={handleSaveImage}
              disabled={isSaving}
              className={`p-3 rounded-2xl text-olive dark:text-dark-olive hover:bg-paper dark:hover:bg-dark-paper transition-all ${isSaving ? 'animate-pulse opacity-50' : ''}`}
              title="Save Snapshot"
            >
              <Save size={24} />
            </button>
            <button
              onClick={handleClear}
              className="p-3 rounded-2xl text-olive dark:text-dark-olive hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 transition-all"
              title="Clear Canvas"
            >
              <Trash2 size={24} />
            </button>
          </div>
        </aside>

        {/* Canvas Area */}
        <div className="flex-1 relative bg-white dark:bg-dark-paper transition-colors" ref={containerRef}>
          <Stage
            width={dimensions.width}
            height={dimensions.height}
            onMouseDown={handleMouseDown}
            onMousemove={handleMouseMove}
            onMouseup={handleMouseUp}
            onTouchStart={handleMouseDown}
            onTouchMove={handleMouseMove}
            onTouchEnd={handleMouseUp}
            ref={stageRef}
            className="cursor-crosshair"
          >
            <Layer>
              {lines.map((line, i) => (
                <KonvaLine
                  key={i}
                  points={line.points}
                  stroke={line.tool === 'eraser' ? (darkMode ? '#1A1A1A' : '#FFFFFF') : line.color}
                  strokeWidth={line.strokeWidth}
                  tension={0.5}
                  lineCap="round"
                  lineJoin="round"
                  globalCompositeOperation={
                    line.tool === 'eraser' ? 'destination-out' : 'source-over'
                  }
                />
              ))}
            </Layer>
          </Stage>
          
          {/* Overlay for "Dual Screen" feel */}
          <div className="absolute inset-0 pointer-events-none border-[12px] border-paper dark:border-dark-paper rounded-none shadow-inner transition-colors" />
          <div className="absolute top-1/2 left-0 right-0 h-px bg-olive/20 dark:bg-dark-olive/20 pointer-events-none" />
          
          {/* Zone Indicators */}
          <div className="absolute top-4 right-4 pointer-events-none flex flex-col items-end gap-1 opacity-40">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-olive dark:text-dark-olive">
              {user?.uid === roomCreator ? "Your Zone (Top)" : "Partner's Zone (Top)"}
            </span>
          </div>
          <div className="absolute bottom-4 right-4 pointer-events-none flex flex-col items-end gap-1 opacity-40">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-olive dark:text-dark-olive">
              {user?.uid !== roomCreator ? "Your Zone (Bottom)" : "Partner's Zone (Bottom)"}
            </span>
          </div>

          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-olive/5 dark:bg-dark-olive/5 pointer-events-none" />
        </div>
      </main>

      {/* Gallery Modal */}
      <AnimatePresence>
        {showGallery && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowGallery(false)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white dark:bg-dark-paper rounded-3xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-olive/10 dark:border-dark-olive/10 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-ink dark:text-dark-ink">Room Gallery</h2>
                <button 
                  onClick={() => setShowGallery(false)}
                  className="text-olive dark:text-dark-olive hover:text-red-600 font-bold"
                >
                  CLOSE
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6">
                {savedImages.length === 0 ? (
                  <div className="text-center py-20 text-olive/40 dark:text-dark-olive/40 italic">
                    No snapshots saved yet. Use the save icon to capture your work!
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                    {savedImages.map((img, idx) => (
                      <div key={idx} className="group relative bg-paper dark:bg-dark-olive-light rounded-2xl overflow-hidden border border-olive/10 dark:border-dark-olive/10 shadow-sm hover:shadow-md transition-all">
                        <img 
                          src={img.url} 
                          alt={`Snapshot ${idx}`} 
                          className="w-full aspect-video object-contain bg-white dark:bg-dark-paper"
                          referrerPolicy="no-referrer"
                        />
                        <div className="p-3 bg-white dark:bg-dark-paper border-t border-olive/5 dark:border-dark-olive/5">
                          <p className="text-[10px] text-olive/60 dark:text-dark-olive/60 uppercase tracking-wider">
                            Saved by {img.savedBy}
                          </p>
                          <p className="text-[10px] text-olive/40 dark:text-dark-olive/40">
                            {new Date(img.timestamp).toLocaleString()}
                          </p>
                        </div>
                        <a 
                          href={img.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100"
                        >
                          <span className="bg-white dark:bg-dark-olive px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest shadow-lg text-ink dark:text-dark-paper">View Full</span>
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Footer Status */}
      <footer className="bg-white dark:bg-dark-olive-light border-t border-olive/10 dark:border-dark-olive/10 px-6 py-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-olive/60 dark:text-dark-olive/60 font-semibold transition-colors">
        <div className="flex gap-4">
          <span>Tool: {tool}</span>
          <span>Size: {strokeWidth}px</span>
        </div>
        <div>
          Live Sync Active • Cloud Persistence Enabled
        </div>
      </footer>
    </div>
  );
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
