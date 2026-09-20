#!/usr/bin/env bash
# 准备 text-to-speech skill 的运行环境（幂等，可重复执行）。
# 系统 Python 是 Homebrew 的，装不了全局包，所以依赖放在独立 venv 里。
set -euo pipefail

TTS_VENV="${TTS_VENV:-$HOME/.venvs/edge-tts}"

if [[ ! -x "$TTS_VENV/bin/python" ]]; then
  echo "创建 venv：$TTS_VENV"
  python3 -m venv "$TTS_VENV"
  "$TTS_VENV/bin/python" -m pip install -q --upgrade pip
fi

"$TTS_VENV/bin/python" -m pip install -q --upgrade edge-tts gTTS
"$TTS_VENV/bin/python" -c "import edge_tts, gtts; print('edge-tts', edge_tts.__version__)"
echo "OK: $TTS_VENV/bin/python"
echo "提示：非 mp3 输出（wav/m4a）需要 ffmpeg，检测结果：$(command -v ffmpeg || echo '未安装')"
