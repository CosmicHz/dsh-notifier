// GENERATED from docs/developer/v1-flash-v3/spec/{CHANNELS,EDITOR-FIELDS}.json.
// Frozen machine fields for v1 descriptors and the editor. Do not hand-edit; no IO.
export const CHANNELS = [
  {
    "id": "telegram",
    "outbound": true,
    "inbound": true,
    "targetFields": [
      "chatId"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/telegram.mjs",
    "inboundSource": "src/inbound/telegram-bot.mjs",
    "outputFile": "src/providers/telegram/index.mjs"
  },
  {
    "id": "dingtalk",
    "outbound": true,
    "inbound": true,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/dingtalk.mjs",
    "inboundSource": "src/inbound/dingtalk-stream.mjs",
    "outputFile": "src/providers/dingtalk/index.mjs"
  },
  {
    "id": "feishu",
    "outbound": true,
    "inbound": true,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/feishu.mjs",
    "inboundSource": "src/inbound/feishu-bot.mjs",
    "outputFile": "src/providers/feishu/index.mjs"
  },
  {
    "id": "wxpusher",
    "outbound": true,
    "inbound": true,
    "targetFields": [
      "uids",
      "topicIds"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/wxpusher.mjs",
    "inboundSource": "src/inbound/wxpusher-callback.mjs",
    "outputFile": "src/providers/wxpusher/index.mjs"
  },
  {
    "id": "pushplus",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/pushplus.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/pushplus/index.mjs"
  },
  {
    "id": "serverchan",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/serverchan.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/serverchan/index.mjs"
  },
  {
    "id": "bark",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/bark.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/bark/index.mjs"
  },
  {
    "id": "webhook",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/webhook.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/webhook/index.mjs"
  },
  {
    "id": "bell",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "local",
    "outboundSource": "src/adapters/bell.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/bell/index.mjs"
  },
  {
    "id": "desktop",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "local",
    "outboundSource": "src/adapters/desktop.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/desktop/index.mjs"
  },
  {
    "id": "slack",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/slack/index.mjs"
  },
  {
    "id": "discord",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/discord/index.mjs"
  },
  {
    "id": "wecom",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/wecom/index.mjs"
  },
  {
    "id": "mattermost",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/mattermost/index.mjs"
  },
  {
    "id": "gchat",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/gchat/index.mjs"
  },
  {
    "id": "teams",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/teams/index.mjs"
  },
  {
    "id": "ntfy",
    "outbound": true,
    "inbound": false,
    "targetFields": [
      "topic"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/ntfy/index.mjs"
  },
  {
    "id": "gotify",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/gotify/index.mjs"
  },
  {
    "id": "pushover",
    "outbound": true,
    "inbound": false,
    "targetFields": [
      "user"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/pushover/index.mjs"
  },
  {
    "id": "chanify",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/chanify/index.mjs"
  },
  {
    "id": "pushdeer",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/pushdeer/index.mjs"
  },
  {
    "id": "xizhi",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/xizhi/index.mjs"
  },
  {
    "id": "qmsg",
    "outbound": true,
    "inbound": false,
    "targetFields": [
      "group"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/qmsg/index.mjs"
  },
  {
    "id": "igot",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/igot/index.mjs"
  },
  {
    "id": "onebot",
    "outbound": true,
    "inbound": false,
    "targetFields": [
      "messageType",
      "userId",
      "groupId"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/onebot/index.mjs"
  },
  {
    "id": "wps-bot",
    "outbound": true,
    "inbound": false,
    "targetFields": [],
    "defaultDestinationKind": "endpoint",
    "outboundSource": "src/adapters/spec-channels.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/wps-bot/index.mjs"
  },
  {
    "id": "qq-bot",
    "outbound": true,
    "inbound": true,
    "targetFields": [
      "targetType",
      "userId",
      "groupId"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/qq-bot.mjs",
    "inboundSource": "src/inbound/qq-gw.mjs",
    "outputFile": "src/providers/qq-bot/index.mjs"
  },
  {
    "id": "wecom-app",
    "outbound": true,
    "inbound": false,
    "targetFields": [
      "toUser"
    ],
    "defaultDestinationKind": "private",
    "outboundSource": "src/adapters/wecom-app.mjs",
    "inboundSource": null,
    "outputFile": "src/providers/wecom-app/index.mjs"
  },
  {
    "id": "wechat-ilink",
    "outbound": false,
    "inbound": true,
    "targetFields": [],
    "defaultDestinationKind": "private",
    "outboundSource": null,
    "inboundSource": "src/channels/wechat-ilink/legacy-core.mjs",
    "outputFile": "src/providers/wechat-ilink/index.mjs"
  }
];

export const EDITOR_FIELDS = [
  {
    "id": "telegram.outbound.botToken",
    "channelId": "telegram",
    "direction": "outbound",
    "field": "botToken",
    "owner": "account",
    "path": "outbound.botToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "机器人令牌",
      "help": "Telegram Bot Token（@BotFather 获取）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写机器人令牌。"
    },
    "en": {
      "label": "Bot token",
      "help": "Bot token from Telegram @BotFather.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter bot token."
    }
  },
  {
    "id": "telegram.outbound.chatId",
    "channelId": "telegram",
    "direction": "outbound",
    "field": "chatId",
    "owner": "destination",
    "path": "target.chatId",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "聊天 ID",
      "help": "接收者的 chat id（可向 @userinfobot 查询）",
      "placeholder": "示例：chatId",
      "errorRequired": "请填写聊天 ID。"
    },
    "en": {
      "label": "Chat ID",
      "help": "Chat ID to receive notifications; @userinfobot can help identify it.",
      "placeholder": "Example chat id",
      "errorRequired": "Enter chat id."
    }
  },
  {
    "id": "telegram.outbound.apiBase",
    "channelId": "telegram",
    "direction": "outbound",
    "field": "apiBase",
    "owner": "account",
    "path": "outbound.apiBase",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "https://api.telegram.org",
    "zh": {
      "label": "API 服务地址",
      "help": "API服务地址",
      "placeholder": "https://example.invalid/notify",
      "errorRequired": "请填写API 服务地址。"
    },
    "en": {
      "label": "API base URL",
      "help": "API base URL; defaults to the documented platform endpoint.",
      "placeholder": "Example api base url",
      "errorRequired": "Enter api base url."
    }
  },
  {
    "id": "telegram.outbound.timeoutMs",
    "channelId": "telegram",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "dingtalk.outbound.webhook",
    "channelId": "dingtalk",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "钉钉群自定义机器人完整地址",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "dingtalk.outbound.secret",
    "channelId": "dingtalk",
    "direction": "outbound",
    "field": "secret",
    "owner": "account",
    "path": "outbound.secret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "签名或应用密钥",
      "help": "加签密钥（机器人安全设置选「加签」时填）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写签名或应用密钥。"
    },
    "en": {
      "label": "Signing or app secret",
      "help": "Secret used by this channel for request signing or application authentication.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter signing or app secret."
    }
  },
  {
    "id": "dingtalk.outbound.atAllOnTimeSensitive",
    "channelId": "dingtalk",
    "direction": "outbound",
    "field": "atAllOnTimeSensitive",
    "owner": "account",
    "path": "outbound.atAllOnTimeSensitive",
    "type": "boolean",
    "control": "switch",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": false,
    "zh": {
      "label": "紧急通知提醒所有人",
      "help": "仅紧急通知@所有人",
      "placeholder": "示例：atAllOnTimeSensitive",
      "errorRequired": "请填写紧急通知提醒所有人。"
    },
    "en": {
      "label": "Mention everyone for urgent notifications",
      "help": "Mention everyone only for time-sensitive messages.",
      "placeholder": "Example mention everyone for urgent notifications",
      "errorRequired": "Enter mention everyone for urgent notifications."
    }
  },
  {
    "id": "dingtalk.outbound.timeoutMs",
    "channelId": "dingtalk",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "feishu.outbound.webhook",
    "channelId": "feishu",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "飞书群自定义机器人完整地址",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "feishu.outbound.secret",
    "channelId": "feishu",
    "direction": "outbound",
    "field": "secret",
    "owner": "account",
    "path": "outbound.secret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "签名或应用密钥",
      "help": "加签密钥（机器人安全设置选「签名校验」时填）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写签名或应用密钥。"
    },
    "en": {
      "label": "Signing or app secret",
      "help": "Secret used by this channel for request signing or application authentication.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter signing or app secret."
    }
  },
  {
    "id": "feishu.outbound.atOpenId",
    "channelId": "feishu",
    "direction": "outbound",
    "field": "atOpenId",
    "owner": "account",
    "path": "outbound.atOpenId",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "",
    "zh": {
      "label": "紧急通知提醒用户",
      "help": "紧急通知时提醒的用户Open ID",
      "placeholder": "示例：atOpenId",
      "errorRequired": "请填写紧急通知提醒用户。"
    },
    "en": {
      "label": "Mention user for urgent notifications",
      "help": "Open ID to mention only for time-sensitive messages.",
      "placeholder": "Example mention user for urgent notifications",
      "errorRequired": "Enter mention user for urgent notifications."
    }
  },
  {
    "id": "feishu.outbound.timeoutMs",
    "channelId": "feishu",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "wxpusher.outbound.appToken",
    "channelId": "wxpusher",
    "direction": "outbound",
    "field": "appToken",
    "owner": "account",
    "path": "outbound.appToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用令牌",
      "help": "WxPusher 应用 APP_TOKEN（wxpusher.zjiecode.com）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用令牌。"
    },
    "en": {
      "label": "App token",
      "help": "Application token used to authenticate this connection.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app token."
    }
  },
  {
    "id": "wxpusher.outbound.uids",
    "channelId": "wxpusher",
    "direction": "outbound",
    "field": "uids",
    "owner": "destination",
    "path": "target.uids",
    "type": "string[]",
    "control": "multiline-list",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收用户 UID",
      "help": "接收者 UID 数组，如 [\"UID_xxx\"]（与 topicIds 至少一项）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收用户 UID。"
    },
    "en": {
      "label": "Recipient UIDs",
      "help": "One recipient UID per line; specify these or topic IDs.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter recipient uids."
    }
  },
  {
    "id": "wxpusher.outbound.topicIds",
    "channelId": "wxpusher",
    "direction": "outbound",
    "field": "topicIds",
    "owner": "destination",
    "path": "target.topicIds",
    "type": "integer[]",
    "control": "multiline-list",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收主题 ID",
      "help": "主题 ID 数组（群发用）",
      "placeholder": "每行一个值",
      "errorRequired": "请填写接收主题 ID。"
    },
    "en": {
      "label": "Topic IDs",
      "help": "One nonnegative topic ID per line; specify these or recipient UIDs.",
      "placeholder": "One value per line",
      "errorRequired": "Enter topic ids."
    }
  },
  {
    "id": "wxpusher.outbound.timeoutMs",
    "channelId": "wxpusher",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "pushplus.outbound.token",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "token",
    "owner": "account",
    "path": "outbound.token",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送令牌",
      "help": "pushplus token（www.pushplus.plus）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送令牌。"
    },
    "en": {
      "label": "Push token",
      "help": "Push token issued by this service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push token."
    }
  },
  {
    "id": "pushplus.outbound.template",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "template",
    "owner": "account",
    "path": "outbound.template",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "markdown",
    "zh": {
      "label": "消息模板",
      "help": "消息格式html/txt/json/markdown",
      "placeholder": "示例：template",
      "errorRequired": "请填写消息模板。"
    },
    "en": {
      "label": "Message template",
      "help": "PushPlus content format.",
      "placeholder": "Example message template",
      "errorRequired": "Enter message template."
    },
    "enum": [
      "html",
      "txt",
      "json",
      "markdown"
    ]
  },
  {
    "id": "pushplus.outbound.channel",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "channel",
    "owner": "account",
    "path": "outbound.channel",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "",
    "zh": {
      "label": "投递渠道",
      "help": "投递渠道，留空使用平台默认",
      "placeholder": "示例：channel",
      "errorRequired": "请填写投递渠道。"
    },
    "en": {
      "label": "Delivery channel",
      "help": "PushPlus delivery channel; blank uses the platform default.",
      "placeholder": "Example delivery channel",
      "errorRequired": "Enter delivery channel."
    },
    "enum": [
      "",
      "wechat",
      "app",
      "extension",
      "webhook",
      "clawbot",
      "cmcc",
      "qq",
      "cp",
      "mail",
      "sms",
      "voice"
    ]
  },
  {
    "id": "pushplus.outbound.topic",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "topic",
    "owner": "account",
    "path": "outbound.topic",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "",
    "zh": {
      "label": "接收主题",
      "help": "接收主题编号",
      "placeholder": "示例：topic",
      "errorRequired": "请填写接收主题。"
    },
    "en": {
      "label": "Topic",
      "help": "Optional topic identifier for the recipient group.",
      "placeholder": "Example topic",
      "errorRequired": "Enter topic."
    }
  },
  {
    "id": "pushplus.outbound.option",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "option",
    "owner": "account",
    "path": "outbound.option",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "",
    "zh": {
      "label": "投递选项",
      "help": "平台投递选项",
      "placeholder": "示例：option",
      "errorRequired": "请填写投递选项。"
    },
    "en": {
      "label": "Delivery option",
      "help": "Optional platform-specific PushPlus delivery option.",
      "placeholder": "Example delivery option",
      "errorRequired": "Enter delivery option."
    }
  },
  {
    "id": "pushplus.outbound.timeoutMs",
    "channelId": "pushplus",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "serverchan.outbound.sct",
    "channelId": "serverchan",
    "direction": "outbound",
    "field": "sct",
    "owner": "account",
    "path": "outbound.sct",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "SENDKEY",
      "help": "Server酱 SENDKEY（sct.ftqq.com；SC3 企业版 sctp 前缀自动走 <数字>.push.ft07.com）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写SENDKEY。"
    },
    "en": {
      "label": "SENDKEY",
      "help": "ServerChan SENDKEY; SC3 keys keep their documented endpoint rules.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter sendkey."
    }
  },
  {
    "id": "serverchan.outbound.timeoutMs",
    "channelId": "serverchan",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "bark.outbound.key",
    "channelId": "bark",
    "direction": "outbound",
    "field": "key",
    "owner": "account",
    "path": "outbound.key",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "Bark 设备 key（App 内复制）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "bark.outbound.barkUrl",
    "channelId": "bark",
    "direction": "outbound",
    "field": "barkUrl",
    "owner": "account",
    "path": "outbound.barkUrl",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "完整推送地址",
      "help": "完整推送地址，包含设备密钥；与独立密钥二选一。",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写完整推送地址。"
    },
    "en": {
      "label": "Full push URL",
      "help": "Complete Bark endpoint including the device key; use instead of a separate key.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter full push url."
    }
  },
  {
    "id": "bark.outbound.device",
    "channelId": "bark",
    "direction": "outbound",
    "field": "device",
    "owner": "account",
    "path": "outbound.device",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "设备名称",
      "help": "设备名（多设备时指定）",
      "placeholder": "示例：device",
      "errorRequired": "请填写设备名称。"
    },
    "en": {
      "label": "Device name",
      "help": "Optional Bark device name.",
      "placeholder": "Example device name",
      "errorRequired": "Enter device name."
    }
  },
  {
    "id": "bark.outbound.server",
    "channelId": "bark",
    "direction": "outbound",
    "field": "server",
    "owner": "account",
    "path": "outbound.server",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "https://api.day.app",
    "zh": {
      "label": "服务地址",
      "help": "服务基础地址；填写完整推送地址时不使用",
      "placeholder": "https://example.invalid/notify",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Server URL",
      "help": "Notification server address; credentials remain separate.",
      "placeholder": "Example server url",
      "errorRequired": "Enter server url."
    }
  },
  {
    "id": "bark.outbound.timeoutMs",
    "channelId": "bark",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 5000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "webhook.outbound.url",
    "channelId": "webhook",
    "direction": "outbound",
    "field": "url",
    "owner": "account",
    "path": "outbound.url",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "接收 POST JSON 的 webhook 地址",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Notification URL",
      "help": "HTTPS endpoint that receives the notification JSON.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter notification url."
    }
  },
  {
    "id": "webhook.outbound.headers",
    "channelId": "webhook",
    "direction": "outbound",
    "field": "headers",
    "owner": "account",
    "path": "outbound.headers",
    "type": "record<string,string>",
    "control": "json",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "附加请求头",
      "help": "附加请求头对象，如 {\"Authorization\": \"...\"}",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写附加请求头。"
    },
    "en": {
      "label": "Extra HTTP headers",
      "help": "JSON object of HTTP header names and string values; stored as a secret.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter extra http headers."
    }
  },
  {
    "id": "webhook.outbound.allowPrivateNetwork",
    "channelId": "webhook",
    "direction": "outbound",
    "field": "allowPrivateNetwork",
    "owner": "account",
    "path": "outbound.allowPrivateNetwork",
    "type": "boolean",
    "control": "switch",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": false,
    "zh": {
      "label": "允许内网通知地址",
      "help": "仅放宽此连接的通知请求，不放宽附件地址",
      "placeholder": "示例：allowPrivateNetwork",
      "errorRequired": "请填写允许内网通知地址。"
    },
    "en": {
      "label": "Allow private notification endpoints",
      "help": "Permit private addresses only for this connection’s outbound notification requests; never for chat attachments.",
      "placeholder": "Example allow private notification endpoints",
      "errorRequired": "Enter allow private notification endpoints."
    }
  },
  {
    "id": "webhook.outbound.timeoutMs",
    "channelId": "webhook",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "bell.outbound.count",
    "channelId": "bell",
    "direction": "outbound",
    "field": "count",
    "owner": "account",
    "path": "outbound.count",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": 1,
    "zh": {
      "label": "响铃次数",
      "help": "响铃次数 1-5（默认 1）",
      "placeholder": "示例：count",
      "errorRequired": "请填写响铃次数。"
    },
    "en": {
      "label": "Bell count",
      "help": "Number of terminal bells, from 1 to 5; default 1.",
      "placeholder": "Example bell count",
      "errorRequired": "Enter bell count."
    },
    "minimum": 1,
    "maximum": 5
  },
  {
    "id": "desktop.outbound.sound",
    "channelId": "desktop",
    "direction": "outbound",
    "field": "sound",
    "owner": "account",
    "path": "outbound.sound",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": "auto",
    "zh": {
      "label": "提示音",
      "help": "提示音：auto（默认，仅紧急级）/ always / never",
      "placeholder": "示例：sound",
      "errorRequired": "请填写提示音。"
    },
    "en": {
      "label": "Sound",
      "help": "Automatic for urgent notifications, always, or never.",
      "placeholder": "Example sound",
      "errorRequired": "Enter sound."
    },
    "enum": [
      "auto",
      "always",
      "never"
    ]
  },
  {
    "id": "slack.outbound.webhook",
    "channelId": "slack",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "Slack Incoming Webhook 完整地址：api.slack.com/apps → 你的 App → Incoming Webhooks → 添加到工作区后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "discord.outbound.webhook",
    "channelId": "discord",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "Discord Webhook 完整地址：服务器设置 → 整合 → Webhook → 新建后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "wecom.outbound.webhook",
    "channelId": "wecom",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "机器人完整 webhook 地址（与 key 二选一）：企业微信群 → 群设置 → 添加群机器人 → 复制 webhook",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "wecom.outbound.key",
    "channelId": "wecom",
    "direction": "outbound",
    "field": "key",
    "owner": "account",
    "path": "outbound.key",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "机器人 key（webhook 地址 ?key= 后面的部分，与 webhook 二选一）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "mattermost.outbound.server",
    "channelId": "mattermost",
    "direction": "outbound",
    "field": "server",
    "owner": "account",
    "path": "outbound.server",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "服务地址",
      "help": "Mattermost 服务器地址（与 webhook 二选一时给全地址可省略），如 https://mm.example.com",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Server URL",
      "help": "Notification server address; credentials remain separate.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter server url."
    }
  },
  {
    "id": "mattermost.outbound.hookId",
    "channelId": "mattermost",
    "direction": "outbound",
    "field": "hookId",
    "owner": "account",
    "path": "outbound.hookId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "机器人 Hook ID",
      "help": "Incoming Webhook 的 id：Mattermost → 集成 → Incoming Webhook 复制地址末段",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写机器人 Hook ID。"
    },
    "en": {
      "label": "Bot hook ID",
      "help": "Hook identifier from the bot integration settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter bot hook id."
    }
  },
  {
    "id": "mattermost.outbound.webhook",
    "channelId": "mattermost",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "Incoming Webhook 完整地址（与 server+hookId 二选一）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "gchat.outbound.webhook",
    "channelId": "gchat",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "Google Chat 空间 Incoming Webhook：空间名旁 ▾ → 应用和集成 → Webhook → 复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "teams.outbound.webhook",
    "channelId": "teams",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "Teams Workflows Incoming Webhook URL：团队频道 → 管理 → 连接器/工作流 → 「将 webhook 请求发布到频道」创建后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "ntfy.outbound.server",
    "channelId": "ntfy",
    "direction": "outbound",
    "field": "server",
    "owner": "account",
    "path": "outbound.server",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": "https://ntfy.sh",
    "zh": {
      "label": "服务地址",
      "help": "ntfy 服务器地址，默认公共站 ntfy.sh，自托管填自己的地址",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Server URL",
      "help": "Notification server address; credentials remain separate.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter server url."
    }
  },
  {
    "id": "ntfy.outbound.topic",
    "channelId": "ntfy",
    "direction": "outbound",
    "field": "topic",
    "owner": "destination",
    "path": "target.topic",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收主题",
      "help": "订阅 topic 名（手机 App 里订阅同名 topic 即可收到；自建服务器建议配 auth）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收主题。"
    },
    "en": {
      "label": "Topic",
      "help": "Optional topic identifier for the recipient group.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter topic."
    }
  },
  {
    "id": "ntfy.outbound.auth",
    "channelId": "ntfy",
    "direction": "outbound",
    "field": "auth",
    "owner": "account",
    "path": "outbound.auth",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "鉴权信息",
      "help": "可选鉴权头原值，如 \"Basic dXNlcjpwYXNz\" 或 \"Bearer tk_...\"（自托管保护 topic 时用）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写鉴权信息。"
    },
    "en": {
      "label": "Authentication",
      "help": "Authentication value required by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter authentication."
    }
  },
  {
    "id": "gotify.outbound.server",
    "channelId": "gotify",
    "direction": "outbound",
    "field": "server",
    "owner": "account",
    "path": "outbound.server",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "服务地址",
      "help": "Gotify 服务器地址，如 https://gotify.example.com（自托管，官方演示站 gotify.net 亦可）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Server URL",
      "help": "Notification server address; credentials remain separate.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter server url."
    }
  },
  {
    "id": "gotify.outbound.appToken",
    "channelId": "gotify",
    "direction": "outbound",
    "field": "appToken",
    "owner": "account",
    "path": "outbound.appToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用令牌",
      "help": "应用 token：Gotify Web → APPS → CREATE APPLICATION 后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用令牌。"
    },
    "en": {
      "label": "App token",
      "help": "Application token used to authenticate this connection.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app token."
    }
  },
  {
    "id": "pushover.outbound.token",
    "channelId": "pushover",
    "direction": "outbound",
    "field": "token",
    "owner": "account",
    "path": "outbound.token",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送令牌",
      "help": "应用 API token：pushover.net → Your Applications → Create 复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送令牌。"
    },
    "en": {
      "label": "Push token",
      "help": "Push token issued by this service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push token."
    }
  },
  {
    "id": "pushover.outbound.user",
    "channelId": "pushover",
    "direction": "outbound",
    "field": "user",
    "owner": "destination",
    "path": "target.user",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收用户",
      "help": "用户/群组 key：pushover.net 首页右上角复制（发送到群组则填群组 key）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收用户。"
    },
    "en": {
      "label": "Recipient user",
      "help": "Recipient identifier issued by this service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter recipient user."
    }
  },
  {
    "id": "chanify.outbound.baseUrl",
    "channelId": "chanify",
    "direction": "outbound",
    "field": "baseUrl",
    "owner": "account",
    "path": "outbound.baseUrl",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": "https://api.chanify.net/v1/sender",
    "zh": {
      "label": "服务地址",
      "help": "Chanify 服务地址，默认公共服务，自托管填自己的",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Base URL",
      "help": "Base address of the notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter base url."
    }
  },
  {
    "id": "chanify.outbound.token",
    "channelId": "chanify",
    "direction": "outbound",
    "field": "token",
    "owner": "account",
    "path": "outbound.token",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送令牌",
      "help": "设备 token：Chanify iOS App → 通道 → 复制 Send Token",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送令牌。"
    },
    "en": {
      "label": "Push token",
      "help": "Push token issued by this service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push token."
    }
  },
  {
    "id": "pushdeer.outbound.pushKey",
    "channelId": "pushdeer",
    "direction": "outbound",
    "field": "pushKey",
    "owner": "account",
    "path": "outbound.pushKey",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "PushKey：PushDeer App → Key 页复制（自建服务配合 endpoint 使用）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key issued by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "pushdeer.outbound.endpoint",
    "channelId": "pushdeer",
    "direction": "outbound",
    "field": "endpoint",
    "owner": "account",
    "path": "outbound.endpoint",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": "https://api2.pushdeer.com",
    "zh": {
      "label": "推送地址",
      "help": "服务地址，默认官方，自建填自己的",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送地址。"
    },
    "en": {
      "label": "Endpoint URL",
      "help": "Full endpoint supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter endpoint url."
    }
  },
  {
    "id": "xizhi.outbound.key",
    "channelId": "xizhi",
    "direction": "outbound",
    "field": "key",
    "owner": "account",
    "path": "outbound.key",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "息知 key：xizhi.qqoq.net 微信扫码登录后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "qmsg.outbound.key",
    "channelId": "qmsg",
    "direction": "outbound",
    "field": "key",
    "owner": "account",
    "path": "outbound.key",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "Qmsg key：qmsg.zendee.cn QQ 登录后复制",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "qmsg.outbound.group",
    "channelId": "qmsg",
    "direction": "outbound",
    "field": "group",
    "owner": "destination",
    "path": "target.group",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "分组",
      "help": "群推送的群号（留空=单聊，目标由 Qmsg 控制台绑定的机器人好友决定）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写分组。"
    },
    "en": {
      "label": "Group",
      "help": "Group identifier used by this channel.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter group."
    }
  },
  {
    "id": "igot.outbound.key",
    "channelId": "igot",
    "direction": "outbound",
    "field": "key",
    "owner": "account",
    "path": "outbound.key",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "推送密钥",
      "help": "iGot key：push.hellyw.com 微信扫码获取",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写推送密钥。"
    },
    "en": {
      "label": "Push key",
      "help": "Push key supplied by this notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter push key."
    }
  },
  {
    "id": "onebot.outbound.baseUrl",
    "channelId": "onebot",
    "direction": "outbound",
    "field": "baseUrl",
    "owner": "account",
    "path": "outbound.baseUrl",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "服务地址",
      "help": "OneBot 实现（NapCat/LLOneBot/go-cqhttp）的 HTTP 服务地址，如 http://127.0.0.1:3000",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写服务地址。"
    },
    "en": {
      "label": "Base URL",
      "help": "Base address of the notification service.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter base url."
    }
  },
  {
    "id": "onebot.outbound.accessToken",
    "channelId": "onebot",
    "direction": "outbound",
    "field": "accessToken",
    "owner": "account",
    "path": "outbound.accessToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "访问令牌",
      "help": "可选 access token（OneBot 配置里设置的鉴权 token）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写访问令牌。"
    },
    "en": {
      "label": "Access token",
      "help": "API access token for this connection.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter access token."
    }
  },
  {
    "id": "onebot.outbound.messageType",
    "channelId": "onebot",
    "direction": "outbound",
    "field": "messageType",
    "owner": "destination",
    "path": "target.messageType",
    "type": "string",
    "control": "select",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": "private",
    "zh": {
      "label": "接收位置类型",
      "help": "private=私聊（默认）/ group=群聊",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收位置类型。"
    },
    "en": {
      "label": "Recipient type",
      "help": "Choose a private recipient or a group.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter recipient type."
    },
    "enum": [
      "private",
      "group"
    ]
  },
  {
    "id": "onebot.outbound.userId",
    "channelId": "onebot",
    "direction": "outbound",
    "field": "userId",
    "owner": "destination",
    "path": "target.userId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收用户 ID",
      "help": "私聊目标 QQ 号（messageType: private 时必填）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收用户 ID。"
    },
    "en": {
      "label": "Recipient user ID",
      "help": "User ID; required when sending to a private user.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter recipient user id."
    }
  },
  {
    "id": "onebot.outbound.groupId",
    "channelId": "onebot",
    "direction": "outbound",
    "field": "groupId",
    "owner": "destination",
    "path": "target.groupId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收群 ID",
      "help": "群号（messageType: group 时必填）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写接收群 ID。"
    },
    "en": {
      "label": "Recipient group ID",
      "help": "Group ID; required when sending to a group.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter recipient group id."
    }
  },
  {
    "id": "wps-bot.outbound.webhook",
    "channelId": "wps-bot",
    "direction": "outbound",
    "field": "webhook",
    "owner": "account",
    "path": "outbound.webhook",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "通知地址",
      "help": "WPS 协作群机器人完整 webhook 地址（含 ?key=）：在 WPS 协作群添加群机器人后复制，形如 https://365.kdocs.cn/woa/api/v1/webhook/send?key=<32 位 key>",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写通知地址。"
    },
    "en": {
      "label": "Webhook URL",
      "help": "Full incoming webhook URL from the platform robot settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter webhook url."
    }
  },
  {
    "id": "wps-bot.outbound.msgtype",
    "channelId": "wps-bot",
    "direction": "outbound",
    "field": "msgtype",
    "owner": "account",
    "path": "outbound.msgtype",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": "text",
    "zh": {
      "label": "消息格式",
      "help": "消息类型：text（默认，标题+正文）或 markdown（富文本）",
      "placeholder": "示例：msgtype",
      "errorRequired": "请填写消息格式。"
    },
    "en": {
      "label": "Message format",
      "help": "Choose the message encoding accepted by the service.",
      "placeholder": "Example message format",
      "errorRequired": "Enter message format."
    },
    "enum": [
      "text",
      "markdown"
    ]
  },
  {
    "id": "qq-bot.outbound.appId",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "appId",
    "owner": "account",
    "path": "outbound.appId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用 ID",
      "help": "QQ 开放平台开发者 ID（q.qq.com → 机器人开发设置）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用 ID。"
    },
    "en": {
      "label": "App ID",
      "help": "Application ID from the platform developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app id."
    }
  },
  {
    "id": "qq-bot.outbound.appSecret",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "appSecret",
    "owner": "account",
    "path": "outbound.appSecret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用密钥",
      "help": "同页面 AppSecret",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用密钥。"
    },
    "en": {
      "label": "App secret",
      "help": "Application secret from the same developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app secret."
    }
  },
  {
    "id": "qq-bot.outbound.targetType",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "targetType",
    "owner": "destination",
    "path": "target.targetType",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": "user",
    "zh": {
      "label": "接收位置类型",
      "help": "\"user\"（单聊，默认）或 \"group\"（群聊）",
      "placeholder": "示例：targetType",
      "errorRequired": "请填写接收位置类型。"
    },
    "en": {
      "label": "Recipient type",
      "help": "Choose a user or a group; fill the corresponding ID.",
      "placeholder": "Example recipient type",
      "errorRequired": "Enter recipient type."
    },
    "enum": [
      "user",
      "group"
    ]
  },
  {
    "id": "qq-bot.outbound.userId",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "userId",
    "owner": "destination",
    "path": "target.userId",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收用户 ID",
      "help": "单聊目标用户 openid（targetType=user 时）",
      "placeholder": "示例：userId",
      "errorRequired": "请填写接收用户 ID。"
    },
    "en": {
      "label": "Recipient user ID",
      "help": "User ID; required when sending to a private user.",
      "placeholder": "Example recipient user id",
      "errorRequired": "Enter recipient user id."
    },
    "requiredWhen": {
      "field": "targetType",
      "equals": "user"
    },
    "visibleWhen": {
      "field": "targetType",
      "equals": "user"
    }
  },
  {
    "id": "qq-bot.outbound.groupId",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "groupId",
    "owner": "destination",
    "path": "target.groupId",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "接收群 ID",
      "help": "群 open id（targetType=group 时）",
      "placeholder": "示例：groupId",
      "errorRequired": "请填写接收群 ID。"
    },
    "en": {
      "label": "Recipient group ID",
      "help": "Group ID; required when sending to a group.",
      "placeholder": "Example recipient group id",
      "errorRequired": "Enter recipient group id."
    },
    "requiredWhen": {
      "field": "targetType",
      "equals": "group"
    },
    "visibleWhen": {
      "field": "targetType",
      "equals": "group"
    }
  },
  {
    "id": "qq-bot.outbound.markdown",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "markdown",
    "owner": "account",
    "path": "outbound.markdown",
    "type": "boolean",
    "control": "switch",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": true,
    "zh": {
      "label": "使用 Markdown",
      "help": "默认 markdown（msg_type=2）；填 false 回退纯文本（msg_type=0）",
      "placeholder": "示例：markdown",
      "errorRequired": "请填写使用 Markdown。"
    },
    "en": {
      "label": "Use Markdown",
      "help": "Send formatted Markdown instead of plain text.",
      "placeholder": "Example use markdown",
      "errorRequired": "Enter use markdown."
    }
  },
  {
    "id": "qq-bot.outbound.apiBase",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "apiBase",
    "owner": "account",
    "path": "outbound.apiBase",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "https://api.sgroup.qq.com",
    "zh": {
      "label": "API 服务地址",
      "help": "QQ官方API地址",
      "placeholder": "https://example.invalid/notify",
      "errorRequired": "请填写API 服务地址。"
    },
    "en": {
      "label": "API base URL",
      "help": "API base URL; defaults to the documented platform endpoint.",
      "placeholder": "Example api base url",
      "errorRequired": "Enter api base url."
    }
  },
  {
    "id": "qq-bot.outbound.rateMs",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "rateMs",
    "owner": "account",
    "path": "outbound.rateMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 1050,
    "zh": {
      "label": "最小发送间隔（毫秒）",
      "help": "最小发送间隔，0–60000毫秒",
      "placeholder": "示例：rateMs",
      "errorRequired": "请填写最小发送间隔（毫秒）。"
    },
    "en": {
      "label": "Minimum send interval (ms)",
      "help": "Minimum gap between QQ notification sends; 0–60000 ms.",
      "placeholder": "Example minimum send interval (ms)",
      "errorRequired": "Enter minimum send interval (ms)."
    },
    "minimum": 0,
    "maximum": 60000
  },
  {
    "id": "qq-bot.outbound.timeoutMs",
    "channelId": "qq-bot",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "wecom-app.outbound.corpid",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "corpid",
    "owner": "account",
    "path": "outbound.corpid",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "企业 ID",
      "help": "企业 ID（企业微信管理后台「我的企业」）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写企业 ID。"
    },
    "en": {
      "label": "Organization ID",
      "help": "Organization ID from the WeCom administration console.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter organization id."
    }
  },
  {
    "id": "wecom-app.outbound.secret",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "secret",
    "owner": "account",
    "path": "outbound.secret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "签名或应用密钥",
      "help": "应用 Secret（管理后台「应用管理」）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写签名或应用密钥。"
    },
    "en": {
      "label": "Signing or app secret",
      "help": "Secret used by this channel for request signing or application authentication.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter signing or app secret."
    }
  },
  {
    "id": "wecom-app.outbound.agentId",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "agentId",
    "owner": "account",
    "path": "outbound.agentId",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用 Agent ID",
      "help": "应用 AgentId（数字）",
      "placeholder": "示例：agentId",
      "errorRequired": "请填写应用 Agent ID。"
    },
    "en": {
      "label": "Agent ID",
      "help": "Numeric application agent ID from the organization console.",
      "placeholder": "Example agent id",
      "errorRequired": "Enter agent id."
    }
  },
  {
    "id": "wecom-app.outbound.toUser",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "toUser",
    "owner": "destination",
    "path": "target.toUser",
    "type": "string",
    "control": "text",
    "exposure": "public",
    "required": false,
    "advanced": false,
    "default": "@all",
    "zh": {
      "label": "接收成员",
      "help": "接收成员账号，默认 \"@all\"",
      "placeholder": "示例：toUser",
      "errorRequired": "请填写接收成员。"
    },
    "en": {
      "label": "Recipients",
      "help": "WeCom member accounts, separated by |; @all addresses all members.",
      "placeholder": "Example recipients",
      "errorRequired": "Enter recipients."
    }
  },
  {
    "id": "wecom-app.outbound.msgtype",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "msgtype",
    "owner": "account",
    "path": "outbound.msgtype",
    "type": "string",
    "control": "select",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": "text",
    "zh": {
      "label": "消息格式",
      "help": "消息格式text/markdown",
      "placeholder": "示例：msgtype",
      "errorRequired": "请填写消息格式。"
    },
    "en": {
      "label": "Message format",
      "help": "Choose the message encoding accepted by the service.",
      "placeholder": "Example message format",
      "errorRequired": "Enter message format."
    },
    "enum": [
      "text",
      "markdown"
    ]
  },
  {
    "id": "wecom-app.outbound.timeoutMs",
    "channelId": "wecom-app",
    "direction": "outbound",
    "field": "timeoutMs",
    "owner": "account",
    "path": "outbound.timeoutMs",
    "type": "integer",
    "control": "number",
    "exposure": "public",
    "required": false,
    "advanced": true,
    "default": 10000,
    "zh": {
      "label": "请求超时（毫秒）",
      "help": "请求超时，1000–60000毫秒",
      "placeholder": "示例：timeoutMs",
      "errorRequired": "请填写请求超时（毫秒）。"
    },
    "en": {
      "label": "Request timeout (ms)",
      "help": "Timeout for one HTTP request; 1000–60000 ms.",
      "placeholder": "Example request timeout (ms)",
      "errorRequired": "Enter request timeout (ms)."
    },
    "minimum": 1000,
    "maximum": 60000
  },
  {
    "id": "telegram.inbound.botToken",
    "channelId": "telegram",
    "direction": "inbound",
    "field": "botToken",
    "owner": "account",
    "path": "inbound.botToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "机器人令牌",
      "help": "Telegram Bot Token（与出站同域）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写机器人令牌。"
    },
    "en": {
      "label": "Bot token",
      "help": "Bot token from Telegram @BotFather.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter bot token."
    }
  },
  {
    "id": "feishu.inbound.appId",
    "channelId": "feishu",
    "direction": "inbound",
    "field": "appId",
    "owner": "account",
    "path": "inbound.appId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用 ID",
      "help": "飞书自建应用 App ID（扫码授权自动写入）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用 ID。"
    },
    "en": {
      "label": "App ID",
      "help": "Application ID from the platform developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app id."
    }
  },
  {
    "id": "feishu.inbound.appSecret",
    "channelId": "feishu",
    "direction": "inbound",
    "field": "appSecret",
    "owner": "account",
    "path": "inbound.appSecret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用密钥",
      "help": "飞书自建应用 App Secret（扫码授权自动写入）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用密钥。"
    },
    "en": {
      "label": "App secret",
      "help": "Application secret from the same developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app secret."
    }
  },
  {
    "id": "qq-bot.inbound.appId",
    "channelId": "qq-bot",
    "direction": "inbound",
    "field": "appId",
    "owner": "account",
    "path": "inbound.appId",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用 ID",
      "help": "QQ 机器人 AppID（在平台开发设置中获取）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用 ID。"
    },
    "en": {
      "label": "App ID",
      "help": "Application ID from the platform developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app id."
    }
  },
  {
    "id": "qq-bot.inbound.appSecret",
    "channelId": "qq-bot",
    "direction": "inbound",
    "field": "appSecret",
    "owner": "account",
    "path": "inbound.appSecret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用密钥",
      "help": "QQ 机器人 AppSecret（在平台开发设置中获取）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用密钥。"
    },
    "en": {
      "label": "App secret",
      "help": "Application secret from the same developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app secret."
    }
  },
  {
    "id": "wxpusher.inbound.appToken",
    "channelId": "wxpusher",
    "direction": "inbound",
    "field": "appToken",
    "owner": "account",
    "path": "inbound.appToken",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用令牌",
      "help": "WxPusher 应用 APP_TOKEN（回调鉴权即凭证）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用令牌。"
    },
    "en": {
      "label": "App token",
      "help": "Application token used to authenticate this connection.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app token."
    }
  },
  {
    "id": "dingtalk.inbound.appKey",
    "channelId": "dingtalk",
    "direction": "inbound",
    "field": "appKey",
    "owner": "account",
    "path": "inbound.appKey",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用 Key",
      "help": "钉钉企业内部应用 AppKey（在平台开发设置中获取）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用 Key。"
    },
    "en": {
      "label": "App key",
      "help": "Application key from the platform developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app key."
    }
  },
  {
    "id": "dingtalk.inbound.appSecret",
    "channelId": "dingtalk",
    "direction": "inbound",
    "field": "appSecret",
    "owner": "account",
    "path": "inbound.appSecret",
    "type": "string",
    "control": "password",
    "exposure": "secret",
    "required": true,
    "advanced": false,
    "default": null,
    "zh": {
      "label": "应用密钥",
      "help": "钉钉企业内部应用 AppSecret（在平台开发设置中获取）",
      "placeholder": "粘贴后保存，不会回显",
      "errorRequired": "请填写应用密钥。"
    },
    "en": {
      "label": "App secret",
      "help": "Application secret from the same developer settings.",
      "placeholder": "Paste to save; never shown again",
      "errorRequired": "Enter app secret."
    }
  }
];
