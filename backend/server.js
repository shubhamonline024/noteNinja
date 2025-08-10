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

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join room for specific note
  socket.on("join-note", (noteId) => {
    socket.join(noteId);
    console.log(`User ${socket.id} joined note room: ${noteId}`);
  });

  // Handle real-time note updates
  socket.on("note-update", async (data) => {
    const { noteId, heading, content } = data;

    try {
      // Encrypt data before storing
      const encryptedHeading = encrypt(heading);
      const encryptedContent = encrypt(content);

      // Update in database
      const { error } = await supabase
        .from("notes")
        .update({
          heading_encrypted: encryptedHeading.encrypted,
          heading_iv: encryptedHeading.iv,
          heading_auth_tag: encryptedHeading.authTag,
          content_encrypted: encryptedContent.encrypted,
          content_iv: encryptedContent.iv,
          content_auth_tag: encryptedContent.authTag,
          updated_at: new Date().toISOString(),
        })
        .eq("note_id", noteId);

      if (!error) {
        // Broadcast to all users in the room except sender
        socket.to(noteId).emit("note-updated", { heading, content });
      }
    } catch (error) {
      console.error("Error updating note:", error);
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

// Save note
app.post("/api/note/:noteId/save", async (req, res) => {
  const { noteId } = req.params;
  const { heading, content } = req.body;

  try {
    // Encrypt data
    const encryptedHeading = encrypt(heading);
    const encryptedContent = encrypt(content);

    const { data, error } = await supabase
      .from("notes")
      .upsert(
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
      )
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: "Note saved successfully" });
  } catch (error) {
    console.error("Error saving note: a45: ", error);
    res.status(500).json({ error: "Failed to save note" });
  }
});

// Delete note
app.delete("/api/note/:noteId", async (req, res) => {
  const { noteId } = req.params;

  try {
    const { error } = await supabase
      .from("notes")
      .delete()
      .eq("note_id", noteId);

    if (error) throw error;

    res.json({ success: true, message: "Note deleted successfully" });
  } catch (error) {
    console.log("here error", noteId);
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

    res.json(decryptedNotes);
  } catch (error) {
    console.error("Error fetching notes:", error);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
