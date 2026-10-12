# A Linux desktop on a virtual screen, with VS Code, code2pdf and screen-recording tools, for the
# README's demo GIFs. Built and run by demos/record.sh.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ca-certificates wget git python3 xvfb xauth xdotool ffmpeg imagemagick matchbox-window-manager \
      dbus-x11 fonts-ubuntu fonts-dejavu-core libsecret-1-0 dmz-cursor-theme >/dev/null \
 && arch=$(dpkg --print-architecture) \
 && wget -qO /tmp/code.deb "https://update.code.visualstudio.com/latest/linux-deb-$arch/stable" \
 && apt-get install -y -qq /tmp/code.deb >/dev/null \
 && wget -qO /tmp/c2p.deb https://github.com/readbysearch/code2pdf/releases/latest/download/code2pdf_all.deb \
 && apt-get install -y -qq /tmp/c2p.deb >/dev/null \
 && rm -f /tmp/*.deb && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash demo
USER demo
WORKDIR /home/demo
