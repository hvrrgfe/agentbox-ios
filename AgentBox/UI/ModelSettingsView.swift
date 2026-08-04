import SwiftUI

/// 模型设置页：导入 GGUF / 粘贴下载链接 / 列出已装模型并可加载删除
struct ModelSettingsView: View {
    @ObservedObject var llamaState: LlamaState

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("导入模型文件（GGUF）")) {
                    LoadCustomButton(llamaState: llamaState)
                }
                Section(header: Text("从网上下载（粘贴 GGUF 链接）")) {
                    InputButton(llamaState: llamaState)
                }
                Section(header: Text("已安装模型")) {
                    if llamaState.downloadedModels.isEmpty {
                        Text("还没有安装模型。请通过上方导入或下载一个 GGUF 模型。")
                            .foregroundColor(.secondary)
                    } else {
                        ForEach(llamaState.downloadedModels) { model in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(model.name)
                                        .font(.body)
                                    Text(model.filename)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                // 当前加载中的标识
                                if llamaState.currentModelName == model.filename {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.green)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                let fileURL = getDocumentsDirectory().appendingPathComponent(model.filename)
                                try? llamaState.loadModel(modelUrl: fileURL)
                            }
                        }
                        .onDelete(perform: delete)
                    }
                }
                Section(header: Text("当前模型")) {
                    Text(llamaState.currentModelName ?? "未加载")
                        .foregroundColor(llamaState.currentModelName == nil ? .secondary : .primary)
                }
                Section(header: Text("提示")) {
                    Text("模型需为 GGUF 格式。可在 Hugging Face 下载如 TinyLlama、Phi、Qwen 等量化模型导入。推荐在 iPhone 上使用 1B-7B 的 Q4/Q8 量化模型，Metal 加速。")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .listStyle(InsetGroupedListStyle())
            .navigationTitle("模型设置")
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }

    func getDocumentsDirectory() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    func delete(at offsets: IndexSet) {
        offsets.forEach { offset in
            let model = llamaState.downloadedModels[offset]
            let fileURL = getDocumentsDirectory().appendingPathComponent(model.filename)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try? FileManager.default.removeItem(at: fileURL)
            }
        }
        // 重新扫描磁盘，保持列表与实际一致
        llamaState.downloadedModels.removeAll { m in
            !FileManager.default.fileExists(
                atPath: getDocumentsDirectory().appendingPathComponent(m.filename).path
            )
        }
    }
}
