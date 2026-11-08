// 閱讀網址 /t/<行程ID>：回分享預覽卡片後轉到唯讀編輯器（說明見 lib/preview.js）
import { renderPreview } from '../../lib/preview.js';
export const onRequest = ctx => renderPreview(ctx, 'read');
