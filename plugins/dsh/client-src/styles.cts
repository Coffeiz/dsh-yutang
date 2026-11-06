const STYLE_ID = 'dsh-yutang/settings-v1'
const css = `
.ytg{display:flex;flex-direction:column;gap:0;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font:inherit}
.ytg *{box-sizing:border-box}
.ytg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 0 16px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ytg-title{font-size:15px;font-weight:620;line-height:1.45}
.ytg-muted{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}
.ytg-status{flex:0 0 auto;padding:4px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.ytg-status.online{background:var(--dsw-alias-state-success-soft,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-success-primary)}
.ytg-card{min-width:0;overflow:visible;padding:0 0 12px;margin:0 0 8px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent}
.ytg-card-head{padding:12px 0 8px;border:0;font-size:14px;font-weight:600}
.ytg-card-body{min-width:0;padding:0}
.ytg-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;min-width:0;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ytg-row:last-child{border-bottom:0}
.ytg-row>div:first-child{flex:1 1 auto;min-width:0}
.ytg-label{display:block;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.ytg-help{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.ytg-control{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,min(50%,300px));flex:1 1 100%;align-items:center;gap:18px;width:100%;min-width:0;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ytg-control>span:first-child{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;white-space:normal}
.ytg-control-checkbox{align-items:start}
.ytg-control-checkbox>.ytg-label{margin:0;padding-top:2px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ytg-checkbox-content{display:flex;flex-direction:column;gap:6px;min-width:0}
.ytg-checkbox-line{display:flex;align-items:flex-start;gap:8px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ytg-checkbox-line input{flex:0 0 16px;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-button-primary-fill));cursor:pointer}
.ytg-checkbox-line input:disabled{cursor:not-allowed}
.ytg-checkbox-help{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.ytg .ytg-control>input:not([type="checkbox"]):not([type="range"]),.ytg .ytg-control>select,.ytg-row>input,.ytg-row>select,.ytg textarea{max-width:100%;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:7px 9px;outline:none}
.ytg .ytg-control>input:not([type="checkbox"]):not([type="range"]):focus,.ytg .ytg-control>select:focus,.ytg-row>input:focus,.ytg-row>select:focus,.ytg textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.ytg-row>input,.ytg-row>select{flex:0 1 300px;width:300px;min-width:0}
.ytg-control>input:not([type="checkbox"]):not([type="range"]),.ytg-control>select,.ytg-control>.ytg-dsh-input{width:100%;min-width:0}
.ytg-control>.ytg-dsh-input{display:flex}
.ytg-control>.ytg-dsh-menu{display:flex;justify-self:end;width:100%;min-width:0}
.ytg-control>.ytg-select-social{width:240px}
.ytg-control>.ytg-select-browse{width:160px}
.ytg-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;height:36px;padding:0 12px!important;border:0!important;border-radius:var(--dsw-radius-md,12px)!important;background:var(--dsw-alias-interactive-bg-hover)!important;color:var(--dsw-alias-label-primary)!important;text-align:left}
.ytg-select-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)!important}
.ytg-select-trigger:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)!important}
.ytg-select-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ytg-select-chevron{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.ytg-select-menu{width:100%;min-width:0!important;max-width:none!important}
.ytg-file-picker{position:relative;display:flex;align-items:center;gap:10px;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.ytg-file-input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;clip-path:inset(50%)}
.ytg-file-name{min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.ytg-server-list{display:grid;gap:8px;padding:8px 0}
.ytg-server-option{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px)}
.ytg-server-option>div{flex:1;min-width:0;overflow-wrap:anywhere}
.ytg-server-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto}
.ytg-server-option.active{background:var(--dsw-alias-interactive-bg-hover)}
.ytg-server-add{display:flex;align-items:flex-end;gap:8px;margin:10px 0}
.ytg-server-add .ytg-control{grid-template-columns:minmax(0,1fr);justify-content:stretch;gap:5px;flex:1;min-width:0;padding:0;border:0}
.ytg-server-add .ytg-control .ytg-help{margin:0}
.ytg-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 0}
.ytg-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.ytg-identity{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 0}
.ytg-identity>div:last-child{min-width:0}
.ytg-idline{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:10px;overflow-wrap:anywhere}
.ytg-avatar{display:grid;flex:0 0 64px;width:64px;height:64px;place-items:center;object-fit:cover;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.ytg-crop-modal{width:min(440px,calc(100vw - 40px));max-height:calc(100vh - 40px)}
.ytg-crop-modal-content,.ytg-crop-modal-content *{box-sizing:border-box;min-width:0}
.ytg-crop-modal-content{display:flex;flex-direction:column;align-items:stretch;gap:0;width:100%;max-width:100%;min-width:0;max-height:min(76vh,760px);overflow-y:auto;overflow-x:clip;overscroll-behavior:contain;padding:0 0 18px}
.ytg-crop-modal-content>div:nth-child(2){align-self:stretch;width:100%;margin-top:24px;padding:0 24px}
.ytg-crop-modal-content>div:nth-child(2)>.ytg-muted{margin:0 0 14px;text-align:center}
.ytg-crop-viewport{position:relative;max-width:100%;flex:0 0 auto;margin-inline:auto;overflow:clip;contain:paint;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);touch-action:none;user-select:none}
.ytg-crop-viewport>img{position:absolute;max-width:none;max-height:none;border:0;border-radius:0;padding:0;pointer-events:none;user-select:none}
.ytg-crop-frame{position:absolute;border:2px solid #fff;box-shadow:0 0 0 999px rgb(0 0 0 / 42%),inset 0 0 0 1px rgb(0 0 0 / 28%);cursor:move;touch-action:none}
.ytg-crop-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,transparent calc(33.333% - 1px),rgb(255 255 255 / 72%) calc(33.333% - 1px),rgb(255 255 255 / 72%) calc(33.333% + 1px),transparent calc(33.333% + 1px),transparent calc(66.666% - 1px),rgb(255 255 255 / 72%) calc(66.666% - 1px),rgb(255 255 255 / 72%) calc(66.666% + 1px),transparent calc(66.666% + 1px)),linear-gradient(to bottom,transparent calc(33.333% - 1px),rgb(255 255 255 / 72%) calc(33.333% - 1px),rgb(255 255 255 / 72%) calc(33.333% + 1px),transparent calc(33.333% + 1px),transparent calc(66.666% - 1px),rgb(255 255 255 / 72%) calc(66.666% - 1px),rgb(255 255 255 / 72%) calc(66.666% + 1px),transparent calc(66.666% + 1px))}
.ytg-crop-handle{position:absolute;z-index:1;width:14px;height:14px;border:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-button-primary-fill));border-radius:50%;background:#fff;touch-action:none}
.ytg-crop-handle.left{left:0}
.ytg-crop-handle.right{right:0}
.ytg-crop-handle.top{top:0}
.ytg-crop-handle.bottom{bottom:0}
.ytg-crop-handle.left.top{transform:translate(-50%,-50%)}
.ytg-crop-handle.right.top{transform:translate(50%,-50%)}
.ytg-crop-handle.left.bottom{transform:translate(-50%,50%)}
.ytg-crop-handle.right.bottom{transform:translate(50%,50%)}
.ytg-crop-modal-content .ytg-actions{width:min(320px,100%);max-width:100%;margin:12px auto 0;padding:0}
.ytg-switch{display:inline-flex;flex:0 0 auto;align-items:center;gap:8px;min-height:28px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.ytg-switch input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-button-primary-fill));cursor:pointer}
.ytg textarea{display:block;width:100%;min-height:112px;resize:vertical;line-height:1.55}
.ytg textarea.wide{min-height:144px}
.ytg-prompt-field{display:flex;flex-direction:column;gap:9px;width:100%;min-width:0;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ytg-prompt-field-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:550;line-height:1.45}
.ytg-prompt-count{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.ytg .ytg-prompt-field>textarea{min-height:176px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:1.6;transition:border-color .15s ease,background-color .15s ease}
.ytg .ytg-prompt-field>textarea:hover{border-color:var(--dsw-alias-border-l2)}
.ytg .ytg-prompt-field>textarea:focus{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base)}
.ytg-card-body>p.ytg-muted{margin:10px 0 4px}
.ytg-diagnostics{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0}
.ytg-diagnostics>div{min-width:0}
.ytg-diagnostics>button{flex:0 0 auto;min-width:max-content;white-space:nowrap}
.ytg-curiosity-status{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.ytg-curiosity-status>div{min-width:0}
.ytg-log-modal{width:min(840px,calc(100vw - 40px));max-height:calc(100vh - 40px)}
.ytg-log-content{max-height:min(72vh,760px);overflow:auto}
.ytg-log-actions{display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px}
.ytg-log{font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.ytg-log-meta{opacity:.65;margin-right:8px}
.ytg-log.warn{color:var(--dsw-alias-state-warn-primary)}
.ytg-log.error{color:var(--dsw-alias-state-error-primary)}
@media(max-width:768px){
  .ytg{gap:0}
  .ytg-head{align-items:flex-start}
  .ytg-row{flex-direction:column;gap:8px;padding:12px 0}
  .ytg-row>input,.ytg-row>select{flex:0 0 auto;width:100%;min-width:0}
  .ytg-control{grid-template-columns:1fr;flex:0 0 auto;width:100%;min-width:0;gap:8px}
  .ytg-control>.ytg-dsh-menu{justify-self:stretch;width:100%}
  .ytg-control>.ytg-select-social,.ytg-control>.ytg-select-browse{width:100%}
  .ytg .ytg-prompt-field>textarea{min-height:160px;padding:12px 14px}
  .ytg-server-add{align-items:stretch;flex-direction:column}
  .ytg-server-option{align-items:flex-start;flex-wrap:wrap}
  .ytg-server-option>div{flex-basis:100%}
  .ytg-server-actions{flex-basis:100%;flex-wrap:wrap}
  .ytg-identity{align-items:flex-start}
  .ytg-curiosity-status{align-items:flex-start;flex-direction:column;gap:8px}
  .ytg-crop-modal{width:min(420px,calc(100vw - 24px))}
  .ytg-crop-modal-content{padding:12px}
  .ytg-actions{justify-content:flex-start}
}
`
export function installStyles(): () => void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {}
  const node = document.createElement('style')
  node.dataset.pluginCss = STYLE_ID
  node.textContent = css
  document.head.appendChild(node)
  return () => node.remove()
}
