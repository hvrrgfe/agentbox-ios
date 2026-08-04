import Foundation

struct Model: Identifiable {
    var id = UUID()
    var name: String
    var url: String
    var filename: String
    var status: String?
}

@MainActor
class LlamaState: ObservableObject {
    @Published var messageLog = ""
    @Published var cacheCleared = false
    @Published var downloadedModels: [Model] = []
    @Published var undownloadedModels: [Model] = []
    @Published var currentModelName: String?
    @Published var modelNameChanged = 0
    let NS_PER_S = 1_000_000_000.0

    private var llamaContext: LlamaContext?
    private var defaultModelUrl: URL? {
        Bundle.main.url(forResource: "ggml-model", withExtension: "gguf", subdirectory: "models")
    }

    init() {
        loadModelsFromDisk()
        loadDefaultModels()
    }

    private func loadModelsFromDisk() {
        do {
            let documentsURL = getDocumentsDirectory()
            let modelURLs = try FileManager.default.contentsOfDirectory(at: documentsURL, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants])
            for modelURL in modelURLs where modelURL.pathExtension.lowercased() == "gguf" {
                let modelName = modelURL.deletingPathExtension().lastPathComponent
                downloadedModels.append(Model(name: modelName, url: "", filename: modelURL.lastPathComponent, status: "downloaded"))
            }
        } catch {
            print("Error loading models from disk: \(error)")
        }
    }

    private func loadDefaultModels() {
        do {
            try loadModel(modelUrl: defaultModelUrl)
        } catch {
            messageLog += "Error!\n"
        }
    }

    func getDocumentsDirectory() -> URL {
        let paths = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
        return paths[0]
    }

    /// 已安装模型的文件名列表（供 Web 层列出）
    func installedModelFilenames() -> [String] {
        downloadedModels.map { $0.filename }
    }

    func loadModel(modelUrl: URL?) throws {
        if let modelUrl {
            messageLog += "Loading model...\n"
            llamaContext = try LlamaContext.create_context(path: modelUrl.path())
            currentModelName = modelUrl.lastPathComponent
            modelNameChanged += 1
            messageLog += "Loaded model \(modelUrl.lastPathComponent)\n"
        } else {
            messageLog += "Load a model from the list below\n"
        }
    }

    /// 用文件名从 Documents 加载模型（Web 层可调用）
    func loadModelByFilename(_ filename: String) {
        let url = getDocumentsDirectory().appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: url.path) {
            try? loadModel(modelUrl: url)
        }
    }

    /// 流式生成：每生成一个 token 调用 streamTo，结束时调用 onDone，返回最终文本
    func complete(text: String,
                  streamTo: @escaping (String) -> Void,
                  onDone: @escaping (String, Double) -> Void) async {
        guard let llamaContext else {
            onDone("【未加载模型】请在设置中导入一个 GGUF 模型文件。", 0)
            return
        }

        let t_start = DispatchTime.now().uptimeNanoseconds
        await llamaContext.completion_init(text: text)
        let t_heat_end = DispatchTime.now().uptimeNanoseconds

        var localFull = ""
        while await !llamaContext.is_done {
            let result = await llamaContext.completion_loop()
            if !result.isEmpty {
                localFull += result
                streamTo(result)
            }
        }

        let t_end = DispatchTime.now().uptimeNanoseconds
        let tg = Double(t_end - t_heat_end) / self.NS_PER_S
        let n = Double(await llamaContext.n_len)
        let tps = tg > 0 ? (n / tg) : 0

        await llamaContext.clear()
        onDone(localFull, tps)
    }

    func bench() async {
        guard let llamaContext else { return }
        messageLog += "\nBenchmark...\n"
        messageLog += "Model info: " + (await llamaContext.model_info()) + "\n"
        let t_start = DispatchTime.now().uptimeNanoseconds
        let _ = await llamaContext.bench(pp: 8, tg: 4, pl: 1)
        let t_end = DispatchTime.now().uptimeNanoseconds
        let t_heat = Double(t_end - t_start) / NS_PER_S
        messageLog += "Heat up: \(t_heat)s\n"
        if t_heat > 5.0 {
            messageLog += "Too slow, aborting benchmark\n"
            return
        }
        let result = await llamaContext.bench(pp: 512, tg: 128, pl: 1, nr: 3)
        messageLog += result + "\n"
    }

    func clear() async {
        guard let llamaContext else { return }
        await llamaContext.clear()
        messageLog = ""
    }
}
