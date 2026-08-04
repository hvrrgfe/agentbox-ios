import SwiftUI
import WebKit

/// Bridge 协议：把一个生成会话的 JS 回调 id 与流式 token 关联起来
struct GenSession {
    let cbId: String
    var buffer: String = ""
}

/// 用 WKWebView 承载 Pi 风格 Agent UI，并桥接原生 llama.cpp 推理
struct WebViewAgent: UIViewRepresentable {
    @ObservedObject var llamaState: LlamaState

    func makeCoordinator() -> Coordinator { Coordinator(llamaState) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        let contentController = webView.configuration.userContentController
        contentController.add(context.coordinator, name: "llama")

        // 注入原生桥接口（与页面脚本配合）
        let bridgeJS = """
        window.WebLobeNative = window.WebLobeNative || {};
        window.WebLobeNative.status = function(status, modelName) {
          if (window.AgentUI && window.AgentUI.nativeStatus) window.AgentUI.nativeStatus(status, modelName || '');
        };
        // 原生推送的 token 流（Swift 用 evaluateJavaScript 调用）
        window.AgentNativeStream = function(cbId, token) {
          if (window.AgentCore && window.AgentCore.onStream) window.AgentCore.onStream(cbId, token);
        };
        window.AgentNativeDone = function(cbId, finalText, meta) {
          if (window.AgentCore && window.AgentCore.onDone) window.AgentCore.onDone(cbId, finalText, meta || {});
        };
        """
        let script = WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(script)

        // 加载内置 Agent 页面
        loadAgentPage(webView)
        context.coordinator.webView = webView

        // 监听刷新通知，重新加载 Agent 页面
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.reloadPage),
            name: .init("AgentRefresh"),
            object: nil
        )
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // 模型变化时通知 Web 层更新状态
        if llamaState.modelNameChanged > 0 {
            let jsName = (llamaState.currentModelName ?? "").replacingOccurrences(of: "\"", with: "'")
            let js = "if(window.AgentUI&&window.AgentUI.nativeStatus)window.AgentUI.nativeStatus('loaded','\(jsName)');"
            uiView.evaluateJavaScript(js, completionHandler: nil)
            llamaState.modelNameChanged = 0
        }
    }

    private func loadAgentPage(_ webView: WKWebView) {
        guard let url = Bundle.main.url(forResource: "agent", withExtension: "html", subdirectory: "Web") else {
            webView.loadHTMLString("<h3>Agent page not found</h3>", baseURL: nil)
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let llamaState: LlamaState
        weak var webView: WKWebView?

        init(_ llamaState: LlamaState) {
            self.llamaState = llamaState
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        @objc func reloadPage() {
            guard let wv = webView, let url = Bundle.main.url(forResource: "agent", withExtension: "html", subdirectory: "Web") else { return }
            wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        // JS 调用原生：webkit.messageHandlers.llama.postMessage({...})
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "llama",
                  let dict = message.body as? [String: Any] else { return }

            switch dict["type"] as? String ?? "" {
            case "gen":
                // 发起一次完整的流式生成
                let text = dict["text"] as? String ?? ""
                let cbId = dict["cbId"] as? String ?? UUID().uuidString
                startGeneration(text: text, cbId: cbId)
            default:
                break
            }
        }

        private func startGeneration(text: String, cbId: String) {
            Task { @MainActor in
                await llamaState.complete(text: text, streamTo: { [weak self] token in
                    self?.pushToken(cbId: cbId, token: token)
                }, onDone: { [weak self] finalText, tps in
                    self?.pushDone(cbId: cbId, finalText: finalText, tps: tps)
                })
            }
        }

        private func pushToken(cbId: String, token: String) {
            guard let wv = webView else { return }
            let safeToken = token
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
            let js = "window.AgentNativeStream('\(cbId)','\(safeToken)');"
            DispatchQueue.main.async {
                wv.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        private func pushDone(cbId: String, finalText: String, tps: Double) {
            guard let wv = webView else { return }
            let safeText = finalText
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let meta = "{tps:\(String(format: "%.2f", tps))}"
            let js = "window.AgentNativeDone('\(cbId)','\(safeText)',\(meta));"
            DispatchQueue.main.async {
                wv.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }
}
