/** 默认弹窗的样式（在 Shadow DOM 里，不影响页面）。浅色 / 深色两套变量，'auto' 跟随系统 */
const LIGHT = '--bg:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb;--hover:#f3f4f6;--accent:#2563eb;--accent-fg:#fff;--danger:#dc2626;--badge:#ecfdf5;--badge-fg:#047857;--shadow:0 20px 50px rgba(0,0,0,.18)'
const DARK = '--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--border:#2e2e33;--hover:#27272a;--accent:#60a5fa;--accent-fg:#0b1220;--danger:#f87171;--badge:#0f2f24;--badge-fg:#6ee7b7;--shadow:0 20px 50px rgba(0,0,0,.6)'

export const STYLES = `
:host{all:initial}
:host([data-theme=light]),:host([data-theme=auto]){${LIGHT}}
:host([data-theme=dark]){${DARK}}
@media (prefers-color-scheme:dark){:host([data-theme=auto]){${DARK}}}
*{box-sizing:border-box}
.backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.4;animation:fade .15s ease-out}
.panel{width:min(380px,100%);max-height:min(600px,100%);display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;outline:none;animation:pop .18s ease-out}
header{display:flex;align-items:center;gap:8px;padding:16px 16px 8px}
h2{flex:1;margin:0;text-align:center;font-size:16px;font-weight:600}
.spacer,.icon-button{width:32px;height:32px;flex:none}
.icon-button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;background:transparent;color:var(--muted);cursor:pointer}
.icon-button:hover{background:var(--hover);color:var(--fg)}
.svg{display:inline-flex}
.tabs{display:flex;gap:4px;margin:4px 16px 0;padding:4px;border-radius:12px;background:var(--hover);overflow-x:auto}
.tab{flex:1;min-width:max-content;padding:6px 10px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:inherit;font-weight:500;cursor:pointer}
.tab.active{background:var(--bg);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.body{flex:1;overflow-y:auto;padding:12px 16px 16px}
.wallets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.wallet{width:100%;display:flex;align-items:center;gap:12px;padding:10px 12px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.wallet:hover,.wallet:focus-visible{background:var(--hover);outline:none}
.icon{width:32px;height:32px;flex:none;border-radius:9px;object-fit:cover}
.icon.large{width:56px;height:56px;border-radius:14px}
.letter{display:inline-flex;align-items:center;justify-content:center;background:var(--hover);color:var(--muted);font-weight:600}
.name{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{flex:1;min-width:0;display:flex;flex-direction:column}
.chips{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.choose-head{display:flex;flex-direction:column;align-items:center;gap:6px;margin:4px 0 12px;text-align:center}
.badge{flex:none;padding:2px 8px;border-radius:999px;background:var(--hover);color:var(--fg);font-size:12px}
.badge.connected{background:var(--badge);color:var(--badge-fg)}
.badge.muted{background:transparent;color:var(--muted)}
.empty{margin:24px 0;text-align:center;color:var(--muted)}
.connecting{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0 4px;text-align:center}
.pending-icon{position:relative;display:inline-flex;margin:8px 0}
.spinner{position:absolute;inset:-6px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:18px;animation:spin .8s linear infinite}
.wallet-name{margin:0;font-weight:600;font-size:15px}
.status{margin:0;color:var(--muted)}
.status.error{color:var(--danger)}
.qr{width:240px;max-width:100%;aspect-ratio:1;padding:8px;border-radius:14px;background:#fff;color:#000;border:1px solid var(--border)}
.qr .svg,.qr svg{width:100%;height:100%;display:block}
.actions{display:flex;gap:8px;margin-top:8px}
.primary,.secondary{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border-radius:10px;font:inherit;font-weight:500;text-decoration:none;cursor:pointer}
.primary{border:0;background:var(--accent);color:var(--accent-fg)}
.secondary{border:1px solid var(--border);background:transparent;color:var(--fg)}
.secondary:hover{background:var(--hover)}
footer{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--border)}
footer .icon{width:24px;height:24px;border-radius:7px}
.address{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.link{border:0;background:transparent;color:var(--danger);font:inherit;cursor:pointer}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}}
@media (max-width:480px){.backdrop{align-items:flex-end;padding:0}.panel{width:100%;max-height:85vh;max-height:85dvh;border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom);animation-name:sheet}}
@keyframes sheet{from{transform:translateY(100%)}}
@media (prefers-reduced-motion:reduce){.backdrop,.panel{animation:none}.spinner{animation-duration:2.4s}}
`
