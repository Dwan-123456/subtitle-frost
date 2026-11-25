# Subtitle Frost · 中文字幕毛玻璃

在 Firefox 里看中英双语视频时，用毛玻璃遮住画面中烧录的中文字幕，留下英文供跟读。适合像哔哩哔哩电影这样，中英文已经压进画面、播放器无法分别关闭的场景。

## 安装（Windows x64 + Firefox）

1. 安装桌面版 Firefox 及 64 位 Python，推荐 Python 3.13。[下载 v1.7 源码](https://github.com/Dwan-123456/subtitle-frost/archive/refs/tags/v1.7.zip)并解压，或运行 `git clone https://github.com/Dwan-123456/subtitle-frost.git`。
2. 在含有 `install.py` 的文件夹打开终端，运行 `py -3.13 install.py`。脚本会创建独立 Python 环境，安装 CPU 版 ONNX Runtime，从模型源下载并校验两个 PP-OCRv3 模型，通过一次本机 OCR 自检后，为当前 Windows 用户注册 Firefox 通信程序。首次安装需要联网。安装后请保留这个文件夹；移动后请重新安装到新位置。
3. 在 Firefox 打开 `about:debugging#/runtime/this-firefox`，点击「临时载入附加组件」，选择源码内的 `firefox/manifest.json`。也可以在这里选择[发行页提供的扩展 ZIP](https://github.com/Dwan-123456/subtitle-frost/releases/tag/v1.7)。重启 Firefox 后需重新临时载入扩展，本机 OCR 只需安装一次。
4. 刷新视频页面，开始播放，再点工具栏中的「中文字幕实时毛玻璃」。首次使用默认识别画面下方的字幕横条。再次点击即可停止。

## 播放时怎么用

| 操作 | 快捷键 | 效果 |
| --- | --- | --- |
| 启动或停止 | Alt + Shift + U | 从视频原始帧裁剪字幕区域，自动启动本机 OCR |
| 调整字幕位置 | Alt + Shift + R | 在视频上拖出包含中、英文两行的横条，扩展会按网站记住选区 |
| 查看性能 | Alt + Shift + I | 识别运行时显示或隐藏统计，包括 OCR 耗时、进程 CPU 和内存 |

检测到中文行时，遮罩四边各向外扩中文字高的 15%，以覆盖笔画和描边。遇到已识别的英文时，遮罩沿整条边收齐，每个中文框都保持矩形。一次命中后至少保持 20 ms，连续两个不同视频帧未匹配后撤掉遮罩，减少一闪一灭。混合文字被识别在同一框内时优先保留可读性。

## 帧同步与使用限制

扩展按浏览器呈现的视频帧更新，从帧时间戳估算片源帧率。在哔哩哔哩，扩展可预读兼容的未加密 MP4 分片。缓存命中时，扩展回查中文字幕的起始帧，目标是提前两个片源帧显示遮罩。若该位置仍有英文，优先保留英文可见。预读不可用时，扩展尝试识别当前帧。实际延迟取决于 CPU、片源和缓冲情况。播放器若禁止读取原始像素，扩展会提示无法读取。普通窗口与播放器全屏均可使用。

视频裁剪和推理都在本机完成，浏览器通过 Native Messaging 把选区图像交给 Python 进程。运行时无需 OCR API 密钥。若提示本机模型无响应，请先重新运行安装命令并确认自检通过，再刷新视频页面。若字幕位于画面上方或超出默认区域，使用重新框选快捷键。

## 源码与许可

`firefox/` 包含帧采样、缓冲预读和遮罩绘制；`host/` 包含本机 OCR 及 Firefox 通信入口。项目代码采用 [MIT 许可证](LICENSE)，保留 [video-subtitle-mask](https://github.com/ZiAn-Su/video-subtitle-mask) 的版权声明。字幕识别的早期参考项目是 [bilibili-caption-project](https://github.com/pijuskri/bilibili-caption-project)。

安装脚本从固定版本的 [RapidOCR 模型仓库](https://huggingface.co/SWHL/RapidOCR/tree/5e7ff7a3692252dd21f42d8c7fd07b9905a1b114/PP-OCRv3) 获取源自 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 的检测和识别模型。第三方模型和依赖各自遵循其上游许可。
