# 字段与文案定稿

spec/EDITOR-FIELDS.json为穷举的生产编辑字段表，含channel/direction/owner/path/type/control/required/条件/default/中英文label/help/placeholder/errorRequired。实施者直接生成src/ui/field-copy.mjs与domain descriptors，不重新编写一套标签或猜控件。spec/FIELD-CONSTRAINTS.json为跨字段规则。provider-fields.json仅原始冻结来源，不能覆盖编辑表修正。
秘密值按描述类型校验后编码为JSON字符串存literal；string值同样JSON编码。env解析所得文本：string字段作为原文本，非string字段JSON.parse并按descriptor校验；不允许eval。secret resolver向provider返回还原后的typed value。出站/入站凭据不自动共用，UI可以明确“复制已保存的同渠道凭据”但本轮不提供此动作，分别配置。
QQ/钉钉只手动填写，文案已移除“扫码自动填入”；Bark完整endpoint与server+key是明确二选一，不沿用旧字段提示错误；WxPusher本地accountId由新系统生成不作为表单项。ServerChan只接受sct，不保留旧别名。
字段默认顺序使用JSON行序；账号字段先、接收位置字段后；advanced默认折叠。枚举label的中文固定：private/user=用户，group=群，auto=仅紧急通知，always=始终，never=不播放；其余协议格式词（Markdown/HTML等）保留名称，英文对应User/Group/Urgent only/Always/Never。空channel枚举为平台默认/Platform default。
跨字段报错：Bark“请填写设备密钥或完整推送地址，二选一。”；WxPusher“请至少填写一个接收用户UID或主题ID。”；条件接收ID“请选择接收位置并填写对应ID。”；每条具同义英文。
任何自定义请求头整体敏感；输入JSON字符串map，禁止Host/Connection/Content-Length/Transfer-Encoding等传输控制header，Authorization可以配置且不可回显。输入仅接受JSON对象字符串值，避免隐式类型转换。来源已有合法官方URL才展示外链，noopener noreferrer；不猜新链接。
