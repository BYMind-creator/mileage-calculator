// 邀請網址 /i/<行程ID>#t=<邀請碼>：回分享預覽卡片後轉到加入頁，邀請碼留在 # 後面（說明見 lib/preview.js）
import { renderPreview } from '../../lib/preview.js';
export const onRequest = ctx => renderPreview(ctx, 'invite');
