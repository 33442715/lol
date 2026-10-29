# GLOBAL BP Online

Minimal deployment bundle for the GLOBAL BP realtime room server.

## Render

1. Create a GitHub repository and upload the **contents of this folder** to the repository root.
2. In Render: New → Blueprint → connect the repository.
3. Render reads `render.yaml`; approve and deploy.
4. Open `https://<service>.onrender.com` and click “在线房间”.

Health check: `/api/health`.

Free Render services sleep after inactivity; sleeping or redeploying clears in-memory rooms.

## Railway / Docker

Start command: `node server/server.mjs`

```bash
docker build -t global-bp .
docker run -p 4173:4173 global-bp
```
