import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Socket.io logic
  const rooms = new Map<string, any[]>();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomCode) => {
      socket.join(roomCode);
      console.log(`User ${socket.id} joined room ${roomCode}`);
      
      // Send existing lines to the new user
      if (rooms.has(roomCode)) {
        socket.emit("initial-data", rooms.get(roomCode));
      } else {
        rooms.set(roomCode, []);
      }
    });

    socket.on("draw", ({ roomCode, line }) => {
      if (rooms.has(roomCode)) {
        rooms.get(roomCode)?.push(line);
      }
      socket.to(roomCode).emit("draw", line);
    });

    socket.on("clear", (roomCode) => {
      if (rooms.has(roomCode)) {
        rooms.set(roomCode, []);
      }
      io.in(roomCode).emit("clear");
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
