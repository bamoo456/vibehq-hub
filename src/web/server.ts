// ============================================================
// Web Server — Express HTTP + WebSocket for VibeHQ Web UI
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { WebSocketServer } from 'ws';
import type { HubContext } from '../hub/server.js';
import { PtyManager } from './pty-manager.js';
import { teamsRouter } from './api/teams.js';
import { agentsRouter } from './api/agents.js';
import { lifecycleRouter } from './api/lifecycle.js';
import { stateRouter } from './api/state.js';
import { filesystemRouter } from './api/filesystem.js';
import { handleTerminalWs } from './ws/terminal.js';
import { handleHubEventsWs } from './ws/hub-events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseCookies(header: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) cookies[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
    }
    return cookies;
}

export interface WebServerOptions {
    port: number;
    hubContext: HubContext;
    hubPort: number;
    team: string;
    configPath: string;
}

export function startWebServer(options: WebServerOptions) {
    const { port, hubContext, hubPort, team, configPath } = options;
    const app = express();
    const server = createServer(app);
    const ptyManager = new PtyManager();

    app.use(express.json());

    // Basic auth — set VIBEHQ_AUTH=user:pass to enable
    // Uses a session token cookie so WebSocket upgrades (which don't carry
    // Basic Auth headers from browsers) can authenticate.
    const authCreds = process.env.VIBEHQ_AUTH; // e.g. "admin:secret123"
    const sessionToken = authCreds ? randomBytes(32).toString('hex') : '';
    // One-time tokens for WebSocket auth (for clients where cookies don't work, e.g. iOS Safari over HTTP)
    const wsTokens = new Set<string>();
    if (authCreds) {
        const expected = 'Basic ' + Buffer.from(authCreds).toString('base64');
        app.use((req, res, next) => {
            // Allow if session cookie is valid
            const cookies = parseCookies(req.headers.cookie || '');
            if (cookies['vibehq_session'] === sessionToken) return next();
            // Otherwise require Basic Auth header
            if (req.headers.authorization === expected) {
                res.setHeader('Set-Cookie', `vibehq_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`);
                return next();
            }
            res.setHeader('WWW-Authenticate', 'Basic realm="VibeHQ"');
            res.status(401).send('Authentication required');
        });

        // Endpoint to get a one-time WebSocket auth token
        // (already behind Basic Auth middleware above)
        app.get('/api/ws-token', (_req, res) => {
            const token = randomBytes(32).toString('hex');
            wsTokens.add(token);
            // Expire token after 30 seconds if unused
            setTimeout(() => wsTokens.delete(token), 30_000);
            res.json({ token });
        });

        console.log('[VibeHQ Web] Basic auth enabled (VIBEHQ_AUTH)');
    }

    // Attach shared state to request
    app.use((req, _res, next) => {
        (req as any).hubContext = hubContext;
        (req as any).ptyManager = ptyManager;
        (req as any).hubPort = hubPort;
        (req as any).defaultTeam = team;
        (req as any).configPath = configPath;
        next();
    });

    // REST API routes
    app.use('/api/teams', teamsRouter);
    app.use('/api/teams', agentsRouter);
    app.use('/api/teams', lifecycleRouter);
    app.use('/api/teams', stateRouter);
    app.use('/api/fs', filesystemRouter);

    // Serve static React build
    const staticDir = join(__dirname, '..', '..', 'web-dist');
    if (existsSync(staticDir)) {
        app.use(express.static(staticDir));
        // SPA fallback (Express 5 uses {*path} instead of *)
        app.get('{*path}', (_req, res) => {
            res.sendFile(join(staticDir, 'index.html'));
        });
    }

    // WebSocket upgrade handling
    const terminalWss = new WebSocketServer({ noServer: true });
    const eventsWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        const url = (request.url || '').split('?')[0]; // strip query params

        // Check auth on WebSocket upgrade via session cookie or one-time token
        // (browsers don't send Basic Auth headers on WebSocket upgrades)
        if (authCreds) {
            const cookies = parseCookies(request.headers.cookie || '');
            const reqUrl = new URL(request.url || '', `http://${request.headers.host}`);
            const wsToken = reqUrl.searchParams.get('token');
            const cookieOk = cookies['vibehq_session'] === sessionToken;
            const tokenOk = wsToken ? wsTokens.delete(wsToken) : false; // delete = one-time use
            if (!cookieOk && !tokenOk) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        if (url.startsWith('/ws/terminal/')) {
            terminalWss.handleUpgrade(request, socket, head, (ws) => {
                const parts = url.replace('/ws/terminal/', '').split('/');
                const teamName = decodeURIComponent(parts[0] || team);
                const agentName = decodeURIComponent(parts[1] || '');
                handleTerminalWs(ws, teamName, agentName, ptyManager);
            });
        } else if (url.startsWith('/ws/events/')) {
            eventsWss.handleUpgrade(request, socket, head, (ws) => {
                const teamName = decodeURIComponent(url.replace('/ws/events/', ''));
                handleHubEventsWs(ws, teamName || team, hubContext, hubPort);
            });
        } else {
            socket.destroy();
        }
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`[VibeHQ Web] Dashboard running at http://localhost:${port}`);
        // Show LAN IP for mobile access
        try {
            const nets = require('os').networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        console.log(`[VibeHQ Web] LAN access: http://${net.address}:${port}`);
                    }
                }
            }
        } catch {}
    });

    return { server, app, ptyManager };
}
