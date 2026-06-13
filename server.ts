import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use body parsing for large base64 uploads
  app.use(express.json({ limit: "20mb" }));

  // Lazy initializer for Google Gen AI client
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    if (!aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Chave do Gemini (GEMINI_API_KEY) não configurada no servidor.");
      }
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiClient;
  }

  // API Route for processing map/image to find bike numbers
  app.post("/api/gemini/process-image", async (req: express.Request, res: express.Response) => {
    try {
      const { image } = req.body;
      if (!image) {
        res.status(400).json({ error: "Nenhuma imagem foi recebida." });
        return;
      }

      // Initialize client lazily to avoid throwing errors during server startup if key is missing
      let ai;
      try {
        ai = getGeminiClient();
      } catch (keyErr: any) {
        res.status(500).json({ error: keyErr.message });
        return;
      }

      // Parse mimeType and base64 string
      const mimeType = image.split(';')[0].split(':')[1] || "image/png";
      const base64Data = image.split(',')[1] || image;

      const imagePart = {
        inlineData: {
          mimeType,
          data: base64Data,
        },
      };

      const textPart = {
        text: "List bike numbers in this map. Return ONLY a JSON array of strings, e.g. [\"123\", \"456\"]. Fast mode.",
      };

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: { parts: [imagePart, textPart] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "STRING" }
          }
        }
      });

      const responseText = response.text || "[]";
      let bikes: string[] = [];
      try {
        bikes = JSON.parse(responseText.trim());
      } catch (e) {
        console.error("Erro ao analisar JSON retornado:", responseText, e);
        // Fallback pattern matching in text if JSON.parse fails
        const matches = responseText.match(/\d+/g);
        if (matches) {
          bikes = Array.from(new Set(matches));
        }
      }

      res.json({ bikes });
    } catch (error: any) {
      console.error("Erro no processamento da imagem com Gemini:", error);
      res.status(500).json({ error: error.message || "Erro interno no servidor de IA." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
