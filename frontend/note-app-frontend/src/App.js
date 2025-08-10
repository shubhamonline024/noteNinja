import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Copy,
  Save,
  Trash2,
  Home,
  Users,
  Wifi,
  WifiOff,
  Clock,
  FileText,
} from "lucide-react";
import io from "socket.io-client";

const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:3001";
const socket = io(API_BASE);

const App = () => {
  const [currentView, setCurrentView] = useState("home");
  const [noteId, setNoteId] = useState("");
  const [heading, setHeading] = useState("");
  const [content, setContent] = useState("");
  const [notes, setNotes] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);

  const saveTimeoutRef = useRef(null);
  const headingRef = useRef(null);
  const contentRef = useRef(null);

  // Socket connection management
  useEffect(() => {
    socket.on("connect", () => {
      setIsConnected(true);
      console.log("Connected to server");
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      console.log("Disconnected from server");
    });

    socket.on("note-updated", (data) => {
      setHeading(data.heading);
      setContent(data.content);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("note-updated");
    };
  }, []);

  // Join note room when noteId changes
  useEffect(() => {
    if (noteId && currentView === "note") {
      socket.emit("join-note", noteId);
    }
  }, [noteId, currentView]);

  // Auto-save functionality
  const autoSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      if (noteId && (heading || content)) {
        await saveNote(false);
      }
    }, 2000);
  }, [noteId, heading, content]);

  // Trigger auto-save on content change
  useEffect(() => {
    if (currentView === "note") {
      autoSave();
    }
  }, [heading, content, autoSave, currentView]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (currentView === "note") {
          saveNote(true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentView, noteId, heading, content]);

  // Create new note
  const createNewNote = async () => {
    try {
      const response = await fetch(`${API_BASE}/`);
      const data = await response.json();
      setNoteId(data.noteUrl);
      setHeading("");
      setContent("");
      setCurrentView("note");
    } catch (error) {
      console.error("Error creating new note:", error);
    }
  };

  // Load note
  const loadNote = async (id) => {
    try {
      const response = await fetch(`${API_BASE}/api/note/${id}`);
      const data = await response.json();

      setNoteId(id);
      setHeading(data.heading || "");
      setContent(data.content || "");
      setLastSaved(data.updatedAt);
      setCurrentView("note");
    } catch (error) {
      console.error("Error loading note:", error);
    }
  };

  // Save note
  const saveNote = async (showFeedback = true) => {
    if (!noteId) return;

    setIsSaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/note/${noteId}/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ heading, content }),
      });

      if (response.ok) {
        setLastSaved(new Date().toISOString());

        // Emit real-time update
        socket.emit("note-update", { noteId, heading, content });

        if (showFeedback) {
          // Visual feedback for manual save
          const saveBtn = document.getElementById("save-btn");
          if (saveBtn) {
            saveBtn.classList.add("bg-green-600");
            setTimeout(() => {
              saveBtn.classList.remove("bg-green-600");
            }, 1000);
          }
        }
      }
    } catch (error) {
      console.error("Error saving note:", error);
    } finally {
      setIsSaving(false);
    }
  };

  // Delete note
  const deleteNote = async () => {
    if (
      !noteId ||
      !window.confirm("Are you sure you want to delete this note?")
    )
      return;

    try {
      const response = await fetch(`${API_BASE}/api/note/${noteId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setCurrentView("home");
        loadNotes();
      }
    } catch (error) {
      console.error("Error deleting note:", error);
    }
  };

  // Load all notes
  const loadNotes = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/notes`);
      const data = await response.json();
      setNotes(data);
    } catch (error) {
      console.error("Error loading notes:", error);
    }
  };

  // Copy URL to clipboard
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/${noteId}`
      );
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error("Error copying URL:", error);
    }
  };

  // Format date
  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  // Load notes when component mounts or when returning to home
  useEffect(() => {
    if (currentView === "home") {
      loadNotes();
    }
  }, [currentView]);

  // Handle URL routing
  useEffect(() => {
    const path = window.location.pathname.slice(1);
    if (path && path !== "home") {
      loadNote(path);
    } else if (path === "home") {
      setCurrentView("home");
    }
  }, []);

  // Update URL when view changes
  useEffect(() => {
    if (currentView === "home") {
      window.history.pushState({}, "", "/home");
    } else if (currentView === "note" && noteId) {
      window.history.pushState({}, "", `/${noteId}`);
    }
  }, [currentView, noteId]);

  if (currentView === "home") {
    return (
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText className="text-blue-600" size={32} />
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">
                    Notes Dashboard
                  </h1>
                  <p className="text-gray-600">Manage your encrypted notes</p>
                </div>
              </div>
              <button
                onClick={createNewNote}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
              >
                <FileText size={20} />
                New Note
              </button>
            </div>
          </div>

          {/* Connection Status */}
          <div className="mb-6">
            <div
              className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
                isConnected
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {isConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
              {isConnected ? "Connected" : "Disconnected"}
            </div>
          </div>

          {/* Notes List */}
          <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold text-gray-900">
                All Notes ({notes.length})
              </h2>
            </div>

            {notes.length === 0 ? (
              <div className="p-12 text-center">
                <FileText className="mx-auto text-gray-400 mb-4" size={48} />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  No notes yet
                </h3>
                <p className="text-gray-600 mb-4">
                  Create your first note to get started
                </p>
                <button
                  onClick={createNewNote}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg inline-flex items-center gap-2"
                >
                  <FileText size={20} />
                  Create Note
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-900">
                        Title
                      </th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-900">
                        Preview
                      </th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-900">
                        Created
                      </th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-900">
                        Updated
                      </th>
                      <th className="px-6 py-3 text-left text-sm font-medium text-gray-900">
                        URL
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {notes.map((note) => (
                      <tr key={note.noteId} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <button
                            onClick={() => loadNote(note.noteId)}
                            className="text-blue-600 hover:text-blue-800 font-medium"
                          >
                            {note.heading || "Untitled"}
                          </button>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-gray-600 text-sm line-clamp-2">
                            {note.content || "No content"}
                          </p>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(note.createdAt)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDate(note.updatedAt)}
                        </td>
                        <td className="px-6 py-4">
                          <code className="bg-gray-100 px-2 py-1 rounded text-sm">
                            /{note.noteId}
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setCurrentView("home")}
              className="text-blue-600 hover:text-blue-800 flex items-center gap-2"
            >
              <Home size={20} />
              Home
            </button>
            <div className="text-gray-300">|</div>
            <div className="flex items-center gap-2">
              <FileText size={20} className="text-gray-600" />
              <span className="font-mono text-sm text-gray-700">/{noteId}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Connection Status */}
            <div
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                isConnected
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
              <Users size={14} />
            </div>

            {/* Copy URL */}
            <button
              onClick={copyUrl}
              className={`px-3 py-2 rounded-lg flex items-center gap-2 text-sm transition-colors ${
                copySuccess
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 hover:bg-gray-200 text-gray-700"
              }`}
            >
              <Copy size={16} />
              {copySuccess ? "Copied!" : "Copy URL"}
            </button>

            {/* Save Button */}
            <button
              id="save-btn"
              onClick={() => saveNote(true)}
              disabled={isSaving}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Save size={16} />
              {isSaving ? "Saving..." : "Save"}
            </button>

            {/* Delete Button */}
            <button
              onClick={deleteNote}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-6xl mx-auto p-4">
        <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
          {/* Note Header */}
          <div className="p-4 border-b">
            <input
              ref={headingRef}
              type="text"
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              placeholder="Enter note title..."
              className="w-full text-xl font-semibold text-gray-900 placeholder-gray-400 border-none outline-none bg-transparent"
            />

            {lastSaved && (
              <div className="flex items-c enter gap-1 text-sm text-gray-500 mt-2">
                <Clock size={14} />
                Last saved: {formatDate(lastSaved)}
              </div>
            )}
          </div>

          {/* Note Content */}
          <div className="p-0">
            <textarea
              ref={contentRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Start typing your note..."
              className="w-full h-96 p-6 text-gray-700 placeholder-gray-400 border-none outline-none resize-none bg-transparent"
              style={{ minHeight: "500px" }}
            />
          </div>
        </div>

        {/* Footer Info */}
        <div className="mt-4 text-center text-sm text-gray-500">
          <p>
            🔐 Your notes are encrypted end-to-end • Auto-saves every 2 seconds
            • Ctrl/Cmd + S to save manually
          </p>
        </div>
      </div>
    </div>
  );
};

export default App;
