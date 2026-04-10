FROM mcr.microsoft.com/devcontainers/base:ubuntu

# 配置非 root 用户 cby
ARG USERNAME=cby
ARG USER_UID=1001
ARG USER_GID=1002

USER root

# 0. 替换 Ubuntu APT 源为国内镜像
RUN sed -i 's|http://archive.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list \
 && sed -i 's|http://security.ubuntu.com/ubuntu/|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list

# 1. 创建或修改用户以匹配宿主机 ID
RUN if getent passwd $USERNAME; then userdel -r $USERNAME; fi \
    && groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m -s /bin/zsh $USERNAME \
    && apt-get update \
    && apt-get install -y sudo file ca-certificates \
    && printf '\n# ---- custom prompt (hide container hostname) ----\nPROMPT="%%n@dev-container %%c %%# "\n' >> /etc/zsh/zshrc \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

# 1.1. 把 vscode 的 oh-my-zsh 和 .zshrc 直接拷给 cby，并把路径替换成 /home/cby
RUN cp -r /home/vscode/.oh-my-zsh /home/${USERNAME}/ \
 && cp /home/vscode/.zshrc /home/${USERNAME}/.zshrc \
 && sed -i "s|/home/vscode|/home/${USERNAME}|g" /home/${USERNAME}/.zshrc \
 && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.oh-my-zsh /home/${USERNAME}/.zshrc


# 2. 安装基础工具
RUN apt-get update && apt-get install -y \
    curl \
    gnupg2 \
    jq \
    vim \
    tmux \
    build-essential
