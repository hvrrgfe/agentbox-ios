# AgentBox — 本地大模型 + 本地 Agent（iOS）

基于 [Pi](https://github.com/fanqi/Pi) 风格的自主 Agent 框架与 **llama.cpp** 原生推理引擎，构建的 iOS 应用。

- **完全本地推理**：Metal GPU，无需任何云端 API。
- **自主 Agent**：Pi/OpenClaw 风格的 reAct 多步循环，可调用本地工具完成任务。
- **灵活导入模型**：支持从"文件"App 导入任意 `.gguf` 模型，或粘贴 Hugging Face 下载链接。
- **离线可用**：模型加载后完全离线。

## 架构

```
┌────────────────────────────────────────────┐
│ SwiftUI 原生层                               │
│  - LlamaState：模型管理 / 加载 / 流式推理     │
│  - LibLlama：llama.cpp C++ 绑定 (Metal)      │
│  - WKWebView：承载 Agent UI + JS 桥          │
└──────────────┬─────────────────────────────┘
               │ JS Bridge (postMessage / evaluateJavaScript)
┌──────────────▼─────────────────────────────┐
│ Web 层 (agent.html / agent.js)              │
│  - Pi 风格 Agent 循环 (reAct + 工具调用)      │
│  - 工具：calculator / note / memory / planner│
│           json_tool / get_time / run_skill   │
│  - 技能系统 (report_writer 等内置 4 技能)     │
│  - 对话模式 + Agent 自主模式                  │
└────────────────────────────────────────────┘
```

## 本地开发 / 调试

需要 macOS + Xcode 15+。

```bash
# 1. 构建 llama.xcframework（生成 build-apple/llama.xcframework）
cd llama.cpp && ./build-xcframework.sh && cd ..

# 2. 打开工程编译（需选择签名 Team）
open AgentBox.xcodeproj
```

## 本项目基于
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — 本地推理引擎与 iOS 示例
- [Pi](https://github.com/fanqi/Pi) — 自主 Agent 框架（reAct 循环 / 工具 / 技能设计参考）
