-- 定义改用 json 而不是 jsonb。
--
-- jsonb 会重排对象键（先按长度、再按字节序）。真机跑第一条流程时就中招了：
-- 文件里 requirement 声明在 issueUrl 之前，好让「从需求文本里抽 issue 链接」
-- 读得到它；存进 jsonb 之后顺序变成 issueUrl 在前，抽取读到 undefined，
-- issueUrl 静默变成 null。
--
-- 引擎已改为按依赖顺序初始化变量，这才是根本修复。这里换成 json 是另一层：
-- 定义是一份「发布什么就该读回什么」的文档，我们从不对它做 JSON 查询，没有
-- 理由让存储层改写作者写下的东西。

ALTER TABLE fleet_workflows
  ALTER COLUMN definition TYPE json USING definition::text::json;
