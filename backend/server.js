const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Encryption functions
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
const ALGORITHM = "aes-256-gcm";

const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, "hex");

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decrypt(encryptedData) {
  const iv = Buffer.from(encryptedData.iv, "hex");
  const authTag = Buffer.from(encryptedData.authTag, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// Generate random URL
function generateRandomUrl(length = 8) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Auto-save functionality
const pendingNotes = new Map(); // Store notes that need to be saved
const saveTimers = new Map(); // Store timers for each note
const noteEditStartTimes = new Map();

async function saveNoteToSupabase(noteId, data) {
  try {
    // Encrypt data
    const encryptedHeading = encrypt(data.heading);
    const encryptedContent = encrypt(data.content);

    const { error } = await supabase.from("notes").upsert(
      {
        note_id: noteId,
        heading_encrypted: encryptedHeading.encrypted,
        heading_iv: encryptedHeading.iv,
        heading_auth_tag: encryptedHeading.authTag,
        content_encrypted: encryptedContent.encrypted,
        content_iv: encryptedContent.iv,
        content_auth_tag: encryptedContent.authTag,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: ["note_id"],
      }
    );

    if (error) throw error;

    console.log(`Note ${noteId} auto-saved successfully`);

    // Remove from pending notes after successful save
    pendingNotes.delete(noteId);

    return true;
  } catch (error) {
    console.error(`Error auto-saving note ${noteId}:`, error);
    return false;
  }
}

function scheduleAutoSave(noteId, data) {
  // Clear existing timer if any
  if (saveTimers.has(noteId)) {
    clearTimeout(saveTimers.get(noteId));
  }

  // Store the latest data
  pendingNotes.set(noteId, data);

  // Set new timer for 2 minutes (120000 ms)
  const timer = setTimeout(async () => {
    const noteData = pendingNotes.get(noteId);
    if (noteData) {
      await saveNoteToSupabase(noteId, noteData);
    }
    saveTimers.delete(noteId);
  }, 120000); // 2 minutes

  saveTimers.set(noteId, timer);
  console.log(`Auto-save scheduled for note ${noteId} in 2 minutes`);
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join room for specific note
  socket.on("join-note", (noteId) => {
    socket.join(noteId);
    console.log(`User ${socket.id} joined note room: ${noteId}`);
  });

  // Handle real-time note updates with auto-save
  socket.on("note-update", async (data) => {
    const { noteId, heading, content } = data;

    try {
      // Set edit start time only once
      if (!noteEditStartTimes.has(noteId)) {
        noteEditStartTimes.set(noteId, new Date().toISOString());
      }

      // Schedule auto-save for this note
      scheduleAutoSave(noteId, {
        heading,
        content,
        created_at: noteEditStartTimes.get(noteId),
        updated_at: new Date().toISOString(),
      });

      // Broadcast to all users in the room except sender
      socket.to(noteId).emit("note-updated", { heading, content });

      console.log(`Note ${noteId} updated and auto-save scheduled`);
    } catch (error) {
      console.error("Error handling note update:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Routes

// Root route - Generate new note URL
app.get("/", (req, res) => {
  const randomUrl = generateRandomUrl();
  res.json({ noteUrl: randomUrl });
});

// Get note by ID
app.get("/api/note/:noteId", async (req, res) => {
  const { noteId } = req.params;

  try {
    // First check if there are pending local changes
    const localData = pendingNotes.get(noteId);

    if (localData) {
      console.log(`Returning local changes for note ${noteId}`);
      return res.json({
        noteId,
        heading: localData.heading,
        content: localData.content,
        updatedAt: localData.updated_at,
        isLocalData: true,
        message: "Returning unsaved local changes",
      });
    }

    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .eq("note_id", noteId)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    if (!data) {
      // Create new note if doesn't exist
      const { data: newNote, error: createError } = await supabase
        .from("notes")
        .insert({
          note_id: noteId,
          heading_encrypted: "",
          heading_iv: "",
          heading_auth_tag: "",
          content_encrypted: "",
          content_iv: "",
          content_auth_tag: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (createError) throw createError;

      return res.json({
        noteId,
        heading: "",
        content: "",
        createdAt: newNote.created_at,
        updatedAt: newNote.updated_at,
      });
    }

    // Decrypt data if exists
    let heading = "";
    let content = "";

    if (data.heading_encrypted) {
      heading = decrypt({
        encrypted: data.heading_encrypted,
        iv: data.heading_iv,
        authTag: data.heading_auth_tag,
      });
    }

    if (data.content_encrypted) {
      content = decrypt({
        encrypted: data.content_encrypted,
        iv: data.content_iv,
        authTag: data.content_auth_tag,
      });
    }

    res.json({
      noteId,
      heading,
      content,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    });
  } catch (error) {
    console.error("Error fetching note:", error);
    res.status(500).json({ error: "Failed to fetch note" });
  }
});

// Manual save endpoint (optional - for force save)
app.post("/api/note/:noteId/force-save", async (req, res) => {
  const { noteId } = req.params;
  const { heading, content } = req.body;

  try {
    const success = await saveNoteToSupabase(noteId, { heading, content });

    if (success) {
      // Clear any pending auto-save for this note since we just saved manually
      if (saveTimers.has(noteId)) {
        clearTimeout(saveTimers.get(noteId));
        saveTimers.delete(noteId);
      }
      pendingNotes.delete(noteId);

      res.json({ success: true, message: "Note force-saved successfully" });
    } else {
      res.status(500).json({ error: "Failed to save note" });
    }
  } catch (error) {
    console.error("Error force-saving note:", error);
    res.status(500).json({ error: "Failed to save note" });
  }
});

// Delete note
app.delete("/api/note/:noteId", async (req, res) => {
  const { noteId } = req.params;

  try {
    // Clear any pending auto-save for this note
    if (saveTimers.has(noteId)) {
      clearTimeout(saveTimers.get(noteId));
      saveTimers.delete(noteId);
    }
    pendingNotes.delete(noteId);

    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("note_id", noteId);

    if (error) throw error;

    res.json({ success: true, message: "Note deleted successfully" });
  } catch (error) {
    console.log("Error deleting note:", noteId);
    console.error("Error deleting note:", error);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// Get all notes for home page
app.get("/api/notes", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    // Decrypt all notes
    const decryptedNotes = data.map((note) => {
      let heading = "Untitled";
      let content = "";

      if (note.heading_encrypted) {
        try {
          heading = decrypt({
            encrypted: note.heading_encrypted,
            iv: note.heading_iv,
            authTag: note.heading_auth_tag,
          });
        } catch (e) {
          heading = "Untitled";
        }
      }

      if (note.content_encrypted) {
        try {
          content = decrypt({
            encrypted: note.content_encrypted,
            iv: note.content_iv,
            authTag: note.content_auth_tag,
          });
        } catch (e) {
          content = "";
        }
      }

      return {
        noteId: note.note_id,
        heading: heading || "Untitled",
        content:
          content.substring(0, 100) + (content.length > 100 ? "..." : ""),
        createdAt: note.created_at,
        updatedAt: note.updated_at,
      };
    });

    for (const [noteId, data] of pendingNotes.entries()) {
      decryptedNotes.unshift({
        noteId: noteId,
        heading: data?.heading || "Untitled",
        content:
          data?.content.substring(0, 100) +
          (data?.content.length > 100 ? "..." : ""),
        createdAt: data?.created_at,
        updatedAt: data?.updated_at,
      });
    }
    res.json(decryptedNotes);
  } catch (error) {
    console.error("Error fetching notes:", error);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Graceful shutdown - save all pending notes
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, saving all pending notes...");

  const savePromises = [];
  for (const [noteId, data] of pendingNotes.entries()) {
    savePromises.push(saveNoteToSupabase(noteId, data));
  }

  try {
    await Promise.all(savePromises);
    console.log("All pending notes saved successfully");
  } catch (error) {
    console.error("Error saving pending notes during shutdown:", error);
  }

  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, saving all pending notes...");

  const savePromises = [];
  for (const [noteId, data] of pendingNotes.entries()) {
    savePromises.push(saveNoteToSupabase(noteId, data));
  }

  try {
    await Promise.all(savePromises);
    console.log("All pending notes saved successfully");
  } catch (error) {
    console.error("Error saving pending notes during shutdown:", error);
  }

  process.exit(0);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
