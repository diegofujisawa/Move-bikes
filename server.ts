import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use body parsing for large base64 uploads
  app.use(express.json({ limit: "20mb" }));
  app.use(express.text({ limit: "20mb", type: "text/plain" }));

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

  // API Route to proxy Google Apps Script requests
  app.all("/api/proxy", async (req: express.Request, res: express.Response) => {
    try {
      const targetUrl = new URL('https://script.google.com/macros/s/AKfycbxqnNTX1M19jUY1hsULYOAkWO1DliXgBUtNAIxNznAl1HJwJUJsZ5h0TCIt135iS_NqWg/exec');
      
      // Copy all incoming query parameters
      Object.entries(req.query).forEach(([key, val]) => {
        if (Array.isArray(val)) {
          val.forEach(v => targetUrl.searchParams.append(key, String(v)));
        } else if (val) {
          targetUrl.searchParams.append(key, String(val));
        }
      });

      const method = req.method;
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Connection': 'close',
      };

      const init: RequestInit = {
        method,
        headers,
        redirect: 'follow',
      };

      if (method === 'POST') {
        headers['Content-Type'] = 'text/plain;charset=utf-8';
        init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      // We use a generous timeout of 120 seconds for the proxy to accommodate slow Apps Script responses
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      init.signal = controller.signal;

      try {
        const response = await fetch(targetUrl.toString(), init);
        clearTimeout(timeoutId);

        const bodyText = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        res.send(bodyText);
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        throw fetchErr;
      }
    } catch (error: any) {
      console.error("Erro no proxy da API:", error);
      res.status(500).json({ success: false, error: "Erro no servidor de proxy da API: " + error.message });
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
