async function getWsToken(): Promise<string | null> {
    try {
        const res = await fetch('/api/ws-token');
        if (!res.ok) return null;
        const { token } = await res.json();
        return token;
    } catch {
        return null;
    }
}

export async function connectTerminal(team: string, agentName: string): Promise<WebSocket> {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/ws/terminal/${encodeURIComponent(team)}/${encodeURIComponent(agentName)}`;
    const token = await getWsToken();
    if (token) url += `?token=${encodeURIComponent(token)}`;
    return new WebSocket(url);
}

export async function connectHubEvents(team: string, onMessage: (msg: any) => void): Promise<WebSocket> {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/ws/events/${encodeURIComponent(team)}`;
    const token = await getWsToken();
    if (token) url += `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
        try {
            onMessage(JSON.parse(event.data));
        } catch {}
    };

    return ws;
}
