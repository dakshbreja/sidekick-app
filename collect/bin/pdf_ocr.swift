// Bounded local OCR for source PDFs; no network or source-file writes.
import Foundation
import PDFKit
import Vision
import AppKit

guard CommandLine.arguments.count == 3,
      let maximum = Int(CommandLine.arguments[2]), maximum > 0,
      let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])),
      document.pageCount > 0, document.pageCount <= maximum else { exit(2) }
var pages: [[String: Any]] = []
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { exit(3) }
    let bounds = page.bounds(for: .mediaBox)
    let scale = 2400 / max(bounds.width, bounds.height)
    let size = NSSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
    let thumbnail = page.thumbnail(of: size, for: .mediaBox)
    var rect = NSRect(origin: .zero, size: size)
    guard let image = thumbnail.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { exit(3) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { exit(4) }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    pages.append(["page": index + 1, "text": lines.joined(separator: "\n")])
}
let result: [String: Any] = ["pages": pages, "page_count": document.pageCount]
guard let output = try? JSONSerialization.data(withJSONObject: result) else { exit(5) }
FileHandle.standardOutput.write(output)
