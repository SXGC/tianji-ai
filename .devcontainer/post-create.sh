#!/usr/bin/env bash
set -euo pipefail

sudo chown -R $(id -u):$(id -g) $HOME

# 注入必要的环境变量（关键步骤）
export OPENCODE_INSTALL="$HOME/.opencode"
# 将 Bun 和 OpenCode 的 bin 目录加入当前 PATH
export PATH="$OPENCODE_INSTALL/bin:$PATH"

npm install -g agent-browser
agent-browser install
curl -fsSL https://claude.ai/install.sh | bash
npm i -g @openai/codex
npm i -g opencode-plugin-langfuse
curl -fsSL https://app.factory.ai/cli | sh
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://forgecode.dev/cli | sh

curl -fsSL https://opencode.ai/install | bash

curl -o- https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.sh | bash

# --- Setup oh-my-opencode --- #
# echo "Configuring oh-my-opencode..."
# if command -v opencode &> /dev/null; then
#     bunx oh-my-opencode install --no-tui --claude=no --openai=no --gemini=no --copilot=no
# else
#     echo "Warning: opencode command not found in PATH, trying to run bunx anyway..."
# fi
# --- End Setup oh-my-opencode --- #

# Add codex alias
echo "alias codexgod='codex --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox'" >> ~/.zshrc
echo "alias claudegod='claude --dangerously-skip-permissions'" >> ~/.zshrc
echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.zshrc
echo 'export LANGFUSE_SECRET_KEY="sk-lf-09f8fa57-4ab1-41f0-ba6e-9fcc6c88a701"' >> ~/.zshrc
echo 'export LANGFUSE_PUBLIC_KEY="pk-lf-c439f578-3255-4859-b9a5-66ca6897bbd3"' >> ~/.zshrc
echo 'export LANGFUSE_BASE_URL="http://100.76.166.80:3001"' >> ~/.zshrc
echo 'export LANGFUSE_BASEURL="http://100.76.166.80:3001"' >> ~/.zshrc
echo 'export SONAR_TOKEN="sqp_f7ddded40f95a90bf3436a1ea1ce4ee7ca5ea85b"' >> ~/.zshrc
echo 'export SONAR_HOST_URL="http://100.76.166.80:9000"' >> ~/.zshrc