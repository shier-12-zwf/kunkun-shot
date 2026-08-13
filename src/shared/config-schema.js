// 默认配置。config.js 会用它做深合并，保证升级后新增字段也有默认值。
const DEFAULT_CONFIG = {
  shortcuts: {
    capture: 'CommandOrControl+Shift+A', // 区域截图
    pinClipboard: 'CommandOrControl+Shift+P', // 把剪贴板里的图贴到屏幕
    pinRestore: 'CommandOrControl+3', // 恢复最近关闭的贴图
    record: 'CommandOrControl+Shift+R', // 区域录屏
    longShot: 'CommandOrControl+Shift+L', // 长截图
    ocr: 'CommandOrControl+Shift+O', // 截图并 OCR
    translate: 'CommandOrControl+Shift+T', // 划词翻译（读取选中文字→弹翻译卡片）
  },
  // AI 提供方选择：deepseek(纯文本，截图走本地OCR→文字) | minimax(M3 支持直接看图)
  //   | openai(通用 OpenAI 兼容：硅基流动/通义千问/Kimi/自定义) | auto(智能分流)
  ai: {
    provider: 'deepseek',
  },
  // 通用 OpenAI 兼容服务商（从 kunkun-translator 移植）：一套配置切换硅基流动/通义千问/Kimi/自定义。
  // 仅用于「纯文本」任务（翻译/润色/对话）；看图任务不走这里（需要多模态，仍用 MiniMax）。
  // preset 决定 baseUrl/model 的默认值来源；custom 时用户自填。apiKey 落盘会被 safeStorage 加密。
  openai: {
    preset: 'siliconflow', // siliconflow | qwen | kimi | custom
    apiKey: '',
    baseUrl: 'https://api.siliconflow.cn/v1', // 请求 {baseUrl}/chat/completions；模型列表 {baseUrl}/models
    model: 'deepseek-ai/DeepSeek-V3',
  },
  // MiniMax：OpenAI 兼容端点，MiniMax-M3 支持图片/视频理解（可直接看图，无需 OCR）
  minimax: {
    apiKey: '',
    baseUrl: 'https://api.minimaxi.com/v1', // 国内站。最终请求 {baseUrl}/chat/completions，Bearer 鉴权，无需 GroupId。海外站为 api.minimax.io，两站密钥不通用
    visionModel: 'MiniMax-M3', // 看图（多模态）
    textModel: 'MiniMax-M3', // 纯文本
  },
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1', // OpenAI 兼容端点，最终请求 {baseUrl}/chat/completions
    // 注意：截至 2026-06，DeepSeek API 仍不支持图片输入（视觉仅在网页/App 灰度）。
    // 因此「截图问 AI / 看图」在纯 DeepSeek 模式下并不会把图发给此模型，而是本地 OCR 抠字后走 textModel；
    // visionModel 仅作占位/未来启用，请勿据此直接发图，否则会 invalid params。想直接看图请用 MiniMax。
    visionModel: 'deepseek-v4-pro',
    textModel: 'deepseek-v4-flash', // 纯文本：翻译 / 润色（也是本地 OCR 之后的处理模型）
    askImagePrompt:
      '请识别并解释这张截图里的内容。如果是题目，直接给出解题过程与最终答案；如果是报错信息，说明原因并给出修复方法；其它情况则简洁说明截图内容。用中文回答。',
    ocrPrompt: '请提取这张图片中的所有文字，按原有排版输出，不要添加任何解释或多余内容。',
    translatePrompt: '请翻译下面这段文字：如果是中文则翻译成英文，否则翻译成中文。只输出翻译结果，不要解释。',
    polishPrompt: '请润色下面这段文字，使其更通顺、专业、自然。保持原意，只输出润色后的文字。',
  },
  ocr: {
    engine: 'local', // 'local'(本地 tesseract.js) | 'model'(大模型看图，走当前 AI 视觉)
    lang: 'chi_sim+eng', // tesseract 语言包
  },
  // 原位翻译：译文盖回原文位置时翻成的目标语言（可在截图工具栏切换，默认中文）
  translate: {
    target: '中文', // 中文 | 英语 | 日语 | 韩语 | 法语 | 德语 | 西班牙语 | 俄语
  },
  // 内置快捷键（截图界面 / 贴图内的单键操作，可自定义；字母统一存小写）
  builtinKeys: {
    cancel: 'Escape', // 截图：取消/关闭（面板先关）
    confirm: 'Enter', // 截图：执行默认动作
    toolSelect: 'v', // 截图：选择/移动工具
    pickColor: 'c', // 截图：取色
    histPrev: '<', // 截图：上一张历史截图
    histNext: '>', // 截图：下一张历史截图
    rectPrev: 'r', // 截图：载入最近选区（Shift+该键=再上一个）
    pinLock: 'l', // 贴图：锁定
    pinTop: 't', // 贴图：置顶切换
    pinSelect: 's', // 贴图：选择文字
    pinPass: 'p', // 贴图：鼠标穿透
    pinThumb: 'r', // 贴图：缩略图模式
  },
  capture: {
    copyAfterCapture: false, // 截完图自动复制到剪贴板
    autoPin: false,
    autoSaveHistory: false, // 是否把每张截图自动存入历史；关=只存手动「保存到本地」的
  },
  recording: {
    fps: 12,
    toGif: true, // 同时导出 GIF
  },
  general: {
    launchAtLogin: false,
    openMainAtLaunch: true, // 启动时打开桌面主窗口（关闭则纯托盘驻留）
    saveDir: '', // 留空则默认存到「图片」目录
    theme: 'light', // light | dark（设置页 UI 用）
  },
};

// 通用 OpenAI 兼容服务商预设表（provider→baseURL→默认模型）。
// 来自 kunkun-translator 的 SettingsStore.swift，2026-07 已联网核实命名空间与端点。
// supportsModelList: 是否支持 GET /models 在线拉取模型清单（聚合平台/自定义最需要）。
const OPENAI_PRESETS = {
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    supportsModelList: true,
    // 未联网刷新前的兜底精选（id 带厂商命名空间，符合硅基流动规范）
    fallbackModels: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'zai-org/GLM-4.6',
      'zai-org/GLM-4.5',
      'MiniMaxAI/MiniMax-M1',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    supportsModelList: false,
    fallbackModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    supportsModelList: false,
    fallbackModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    defaultModel: '',
    supportsModelList: true,
    fallbackModels: [],
  },
};

module.exports = { DEFAULT_CONFIG, OPENAI_PRESETS };
