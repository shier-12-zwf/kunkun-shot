// IPC 通道名常量 —— 主进程(ipcMain) 与 preload(ipcRenderer) 共同引用，是整个 app 的契约单一来源。
// 渲染层不直接用这些字符串，而是通过 preload 暴露的 window.kkapi 调用。
//
// ⚠️ 同步契约警告：窗口已开启 sandbox: true，沙箱化 preload 无法 require 本文件，
// src/preload/preload.js 里保存了一份内联副本。新增 / 改名 / 删除通道时两处必须同步更新。
module.exports = {
  // ---- 配置 ----
  CONFIG_GET: 'config:get', // () => config
  CONFIG_SET: 'config:set', // (patch) => config | { ok:false, error, config }（事务失败）

  // ---- 窗口控制 ----
  WINDOW_INIT: 'window:init', // (main->renderer) 窗口初始化数据
  WINDOW_CLOSE_SELF: 'window:close-self',
  WINDOW_MINIMIZE_SELF: 'window:minimize-self',
  WINDOW_RESIZE_SELF: 'window:resize-self', // ({width,height}) 以中心为锚点缩放当前窗口（贴图捏合缩放用）
  WINDOW_MOVE_SELF: 'window:move-self', // ({dx,dy}) 按增量移动当前窗口（贴图 JS 拖动用）
  OPEN_SETTINGS: 'window:open-settings',
  OPEN_AI_PANEL: 'window:open-ai', // (payload) 打开 AI 面板并附带初始数据

  // ---- 截图捕获 ----
  CAPTURE_TRIGGER: 'capture:trigger', // (mode) 主动发起一次捕获：'region' | 'long' | 'record' | 'ocr'
  CAPTURE_REGION: 'capture:region', // ({ rect, displayId, scaleFactor }) => dataURL  长截图逐帧用
  CAPTURE_GET_SOURCES: 'capture:get-sources', // () => [{ id, name, display_id, thumbnail }]
  LONGSHOT_UPDATE: 'longshot:update', // controls -> main，受限缩略图、尺寸、帧数与展开状态
  LONGSHOT_STATE: 'longshot:state', // main -> guide，显示器局部布局与最新预览

  // ---- 截图层结果 ----
  OVERLAY_RESULT: 'overlay:result', // ({ action, rect, imageDataURL, displayId }) action: copy|save|pin|ocr|ask|record|long
  OVERLAY_CANCEL: 'overlay:cancel',

  // ---- 剪贴板 / 保存 ----
  CLIPBOARD_WRITE_IMAGE: 'clipboard:write-image', // (dataURL)
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text', // (text)
  CLIPBOARD_READ_IMAGE: 'clipboard:read-image', // () => dataURL | null
  IMAGE_SAVE: 'image:save', // (dataURL) => { saved, path?, format?, quality?, canceled?, error? }
  CHOOSE_SAVE_DIR: 'dialog:choose-save-dir', // () => { dir } 选择截图保存目录

  // ---- 贴图 ----
  PIN_CREATE: 'pin:create', // ({ dataURL, bounds }) 在屏幕上钉一张图
  PIN_SET_STATE: 'pin:set-state', // ({ onTop?, ignoreMouse?, opacity?, locked?, title? }) 更新当前贴图窗状态
  PIN_UPDATE_CONTENT: 'pin:update-content', // ({ baseRevision, revision, dataURL }) 原子更新标注后的贴图内容
  PIN_REPLACE_IMAGE: 'pin:replace-image', // ({ baseRevision, revision, dataURL, sourceWidth, sourceHeight, width, height }) 裁剪/旋转/翻转后原子替换图片
  PIN_GROUP_ACTION: 'pin:group-action', // ({ action }) 分组 / 折叠或展开 / 解组
  PIN_CLOSE_READY: 'pin:close-ready', // ({ requestId, ok, error? }) 退出前已将最新标注同步到主进程
  PIN_SYNC_READY: 'pin:sync-ready', // ({ requestId, ok, error? }) “保存全部”读取快照前的非冻结同步回执
  PIN_CMD: 'pin:cmd', // (main->pin) { cmd: 'thumb'|'passthrough-off'|'save', on? } 贴图批量指令
  PIN_START_DRAG: 'pin:start-drag', // (pin->main) 把贴图内容拖出窗口到其它应用
  FORMULA_CREATE_PIN: 'formula:create-pin', // (formula->main) ({ dataURL }) 将本地渲染的公式 PNG 创建为贴图

  // ---- OCR ----
  OCR_RUN: 'ocr:run',
  AX_AT_POINT: 'ax:at-point', // ({x,y}) 查询屏幕坐标处 UI 元素（智能识别）
  OCR_BOXES: 'ocr:boxes',
  TRANSLATE_TEXT: 'ai:translate-text', // ({ lines, target }) => { lines, error }

  // ---- DeepSeek ----
  DEEPSEEK_ASK_IMAGE: 'deepseek:ask-image', // ({ dataURL, prompt, streamId }) => { ok }
  AI_RECOGNIZE_IMAGE: 'ai:recognize-image', // ({ mode:'table'|'formula', dataURL, streamId }) => { ok }; prompt 由主进程固定
  DEEPSEEK_CHAT: 'deepseek:chat', // ({ messages, streamId, model }) => { ok }
  DEEPSEEK_STREAM: 'deepseek:stream', // (main->renderer) { streamId, delta, done, error }
  DEEPSEEK_TEST: 'deepseek:test', // () => { ok, message } 设置页测试连通性
  DEEPSEEK_CANCEL: 'deepseek:cancel', // (streamId) 主动取消一条进行中的流（切流/关窗时调用）
  AI_FETCH_MODELS: 'ai:fetch-models', // ({ baseUrl, apiKey }) => { ok, models:[id...], error } 在线拉取模型清单

  // ---- 划词翻译（全局）----
  TRANSLATE_POPUP_DATA: 'translate:popup-data', // (main->popup) { text, target, loading?, translation?, error? } 划词卡片数据推送
  TRANSLATE_POPUP_CLOSE: 'translate:popup-close', // (popup->main) 关闭划词卡片

  // ---- 录屏 ----
  RECORD_SAVE: 'record:save', // ({ buffer, mime, toGif, fps }) => { saved, path, fallback?, warning? }
  RECORD_STATE: 'record:state', // ({ state, generation, saveAttempt }) => { ok }; 主进程据此防止二次启动/关闭丢失未保存内容
  RECORD_ACTION_START: 'record:action-start', // () => { ok, active, error? } 开启本次录屏的操作提示监听
  RECORD_ACTION_STOP: 'record:action-stop', // () => { ok, active } 停止并清理监听 helper
  RECORD_ACTION_EVENT: 'record:action-event', // (main->recorder) 鼠标/按键瞬时事件，不落盘

  // ---- 外部链接 ----
  OPEN_EXTERNAL: 'shell:open-external', // (url) 仅允许 http(s)，走系统浏览器
  OPEN_PATH: 'shell:open-path', // (p) 打开本地文件（绝对路径存在性校验）

  // ---- 主窗口 / 菜单栏弹窗 ----
  OPEN_MAIN: 'window:open-main', // (page?) 打开桌面主窗口，可指定默认页
  MAIN_NAV: 'main:nav', // (main->renderer) 让主窗口切到某页 { page }
  POPOVER_TOGGLE: 'popover:toggle',
  POPOVER_HIDE: 'popover:hide',

  // ---- 新捕获模式 ----
  CAPTURE_FULLSCREEN_NOW: 'capture:fullscreen-now', // 立即整屏截图 -> 存历史+复制
  CAPTURE_WINDOW: 'capture:window', // 交互式窗口截图（screencapture -w）
  CAPTURE_TIMED: 'capture:timed', // ({ delay, mode }) 倒计时后截图
  CAPTURE_TIMED_CANCEL: 'capture:timed-cancel', // (jobId) 取消尚未触发的主进程定时截图

  // ---- 历史记录 ----
  HISTORY_LIST: 'history:list', // ({includeMedia?}) => [{id,time,width,height,type,kind,thumb}]
  HISTORY_GET: 'history:get', // (id) => { item, dataURL }
  HISTORY_DELETE: 'history:delete', // (id)
  HISTORY_DELETE_MANY: 'history:delete-many', // (ids[]) 批量删除，一次写盘+一次广播
  HISTORY_EXPORT: 'history:export', // (id) => { saved, path }
  HISTORY_EXPORT_MANY: 'history:export-many', // (ids[]) => { saved, count, dir } 选一次目录批量导出
  HISTORY_EXPORT_PDF: 'history:export-pdf', // (ids[]) => { saved, path, pageCount } 合并图片历史为多页 PDF
  HISTORY_CLEAR: 'history:clear',
  HISTORY_CHANGED: 'history:changed', // (main->renderer) 历史变动，刷新列表
};
