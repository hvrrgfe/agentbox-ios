import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject var llamaState = LlamaState()

    var body: some View {
        TabView {
            // Tab 1: 本地 Agent 聊天（WebView 承载，原生推理桥接）
            AgentHome(llamaState: llamaState)
                .tabItem {
                    Label("Agent", systemImage: "brain.head.profile")
                }

            // Tab 2: 模型设置
            ModelSettingsView(llamaState: llamaState)
                .tabItem {
                    Label("模型", systemImage: "square.grid.2x2")
                }
        }
    }
}

/// Agent 聊天容器：顶部工具栏 + WebView
struct AgentHome: View {
    @ObservedObject var llamaState: LlamaState

    var body: some View {
        NavigationView {
            ZStack {
                WebViewAgent(llamaState: llamaState)
            }
            .navigationTitle("AgentBox")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        // 通知 WebView 刷新重新加载 Agent 页面
                        NotificationCenter.default.post(name: .init("AgentRefresh"), object: nil)
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
