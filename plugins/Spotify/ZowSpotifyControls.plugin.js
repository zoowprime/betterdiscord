/**
 * @name ZowSpotifyControls
 * @author zow.py
 * @version 1.0.0
 * @description Minimal Spotify control bar in the channel panel (no external library). Uses your Discord-linked Spotify to play/pause, next/previous, and shows track info/cover.
 * @source https://github.com/zoowprime/betterdiscord
 * @updateUrl https://raw.githubusercontent.com/zoowprime/betterdiscord/main/plugins/YoteiSpotifyControls/YoteiSpotifyControls.plugin.js
 */

module.exports = class YoteiSpotifyControls {
  constructor() {
    this.panelId = "yotei-spotify-controls";
    this.css = `
      #${this.panelId}{
        display:flex; align-items:center; gap:8px;
        min-height:52px; padding:8px; margin-bottom:8px;
        border-radius:10px;
        background: var(--background-tertiary, rgba(0,0,0,.35));
        backdrop-filter: blur(8px);
      }
      #${this.panelId} .ysc-cover{ width:32px; height:32px; border-radius:4px; overflow:hidden; flex:0 0 auto; background:#222 }
      #${this.panelId} .ysc-cover img{ width:100%; height:100%; object-fit:cover; display:block }
      #${this.panelId} .ysc-meta{ min-width:0; flex:1 1 auto }
      #${this.panelId} .ysc-title{ font-weight:600; color:var(--text-primary,#fff); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
      #${this.panelId} .ysc-artist{ font-size:12px; color:var(--text-muted,#ccc); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
      #${this.panelId} .ysc-btns{ display:flex; align-items:center; gap:6px }
      #${this.panelId} .ysc-btn{
        border:0; padding:6px 8px; border-radius:8px; cursor:pointer;
        background: var(--background-modifier-hover, rgba(255,255,255,.08));
        color:var(--text-primary,#fff); font-size:12px;
      }
      #${this.panelId} .ysc-btn:disabled{ opacity:.4; cursor:not-allowed }
    `;
  }

  /* ====== Discord modules we need (via BdApi.Webpack) ====== */
  _mods() {
    const byProps = BdApi.Webpack.getModule;
    return {
      SpotifyStore: byProps(m => m?.getActivity && m?.getActiveSocketAndDevice),
      SpotifyUtils: byProps(m => m?.getAccessToken && m?.pause && m?.play),
      ConnectedAccountsStore: byProps(m => m?.getAccounts && m?.getAccount)
    };
  }

  log(...a){ console.log("[YoteiSpotifyControls]", ...a); }

  /* ====== UI helpers ====== */
  mountPanel() {
    if (document.getElementById(this.panelId)) return;
    const channelPanels = document.querySelector('[class*="channelAppLauncher"]')?.parentElement
                       || document.querySelector('[class*="channelTextArea"]')?.parentElement
                       || document.querySelector('[class*="channelpanels"]');
    if (!channelPanels) return;

    const panel = document.createElement("div");
    panel.id = this.panelId;
    panel.innerHTML = `
      <div class="ysc-cover"><img style="display:none" alt=""></div>
      <div class="ysc-meta">
        <div class="ysc-title">No Spotify playing</div>
        <div class="ysc-artist">Connect Spotify in User Settings → Connections</div>
      </div>
      <div class="ysc-btns">
        <button class="ysc-btn" data-act="prev" title="Previous">⏮</button>
        <button class="ysc-btn" data-act="toggle" title="Play/Pause">⏯</button>
        <button class="ysc-btn" data-act="next" title="Next">⏭</button>
      </div>
    `;
    channelPanels.prepend(panel);
    this.panel = panel;

    panel.addEventListener("click", (e) => {
      const btn = e.target.closest(".ysc-btn");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      this.handleAction(act).catch(() => BdApi.UI.showToast("Spotify request failed", {type:"error"}));
    });
  }

  unmountPanel() {
    const el = document.getElementById(this.panelId);
    if (el) el.remove();
  }

  setLoading(loading=true){
    if (!this.panel) return;
    [...this.panel.querySelectorAll(".ysc-btn")].forEach(b=> b.disabled = loading);
  }

  updateUI(track, isPlaying){
    if (!this.panel) return;
    const title = this.panel.querySelector(".ysc-title");
    const artist = this.panel.querySelector(".ysc-artist");
    const img = this.panel.querySelector(".ysc-cover img");

    if (!track){
      title.textContent = "No Spotify playing";
      artist.textContent = "Start a song on any device";
      img.style.display = "none";
      return;
    }

    title.textContent = track.name || "Unknown title";
    artist.textContent = (track.artists?.map(a=>a.name).join(", ")) || "Unknown artist";
    const art = track.album?.images?.[0]?.url;
    if (art){ img.src = art; img.style.display = "block"; } else img.style.display = "none";

    const toggle = this.panel.querySelector('[data-act="toggle"]');
    toggle.textContent = isPlaying ? "⏸" : "▶️";
  }

  /* ====== Spotify helpers ====== */
  async getAuthAndDevice(){
    const {SpotifyStore, SpotifyUtils, ConnectedAccountsStore} = this._mods();
    if (!SpotifyStore || !SpotifyUtils) throw "Spotify modules not found";

    const sockDev = SpotifyStore.getActiveSocketAndDevice?.();
    const account = ConnectedAccountsStore?.getAccounts?.().find(a => a.type === "spotify");
    const accountId = account?.id;

    // Try token from socket first, else refresh
    let accessToken = sockDev?.socket?.accessToken;
    if (!accessToken && accountId) {
      try { accessToken = await SpotifyUtils.getAccessToken(accountId); } catch {}
    }
    return {accessToken, device: sockDev?.device, socket: sockDev?.socket};
  }

  async request(path, method="GET", body){
    const {accessToken, device} = await this.getAuthAndDevice();
    if (!accessToken) throw "No Spotify token";
    const url = new URL(`https://api.spotify.com/v1/me/player${path}`);
    if (device?.id && !/device_id=/.test(url.search)) url.searchParams.set("device_id", device.id);

    const res = await BdApi.Net.fetch(url.toString(), {
      method,
      headers: { "authorization": `Bearer ${accessToken}`, "content-type":"application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return {};
    return await res.json().catch(()=> ({}));
  }

  async fetchState(){
    // current playback
    try {
      const state = await this.request("", "GET");
      const track = state?.item;
      this.updateUI(track, !!state?.is_playing);
    } catch (e) {
      this.updateUI(null, false);
    }
  }

  async handleAction(act){
    this.setLoading(true);
    try {
      if (act === "prev") await this.request("/previous", "POST");
      else if (act === "next") await this.request("/next", "POST");
      else if (act === "toggle") {
        // get state then play/pause
        const state = await this.request("", "GET");
        if (state?.is_playing) await this.request("/pause", "PUT");
        else await this.request("/play", "PUT");
      }
      setTimeout(()=> this.fetchState(), 350);
    } finally { this.setLoading(false); }
  }

  /* ====== Plugin lifecycle ====== */
  start() {
    BdApi.DOM.addStyle("yotei-spotify-controls-style", this.css);
    this.mountPanel();
    this.fetchState();
    // Poll every 5s to keep UI in sync
    this.interval = setInterval(()=> this.fetchState(), 5000);

    // Rerender hook when channel panels mount
    this.mo = new MutationObserver(() => this.mountPanel());
    this.mo.observe(document.body, {childList:true, subtree:true});
  }

  stop() {
    clearInterval(this.interval);
    this.mo && this.mo.disconnect();
    BdApi.DOM.removeStyle("yotei-spotify-controls-style");
    this.unmountPanel();
  }
};
