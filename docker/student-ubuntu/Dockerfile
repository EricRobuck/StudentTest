# Student exam environment: one container per exam session.
# Build:  npm run image:build   (tags linuxlab/student-ubuntu:24.04)
#
# Security notes:
# - The interactive shell runs as the unprivileged user `student` (uid 1000)
#   with a locked password.
# - All setuid/setgid bits are stripped except sudo's. sudo only works in
#   exams with "Students can use sudo" turned on: every other container runs
#   with no-new-privileges, which makes sudo refuse to run.
# - Network, capabilities, and resource limits are applied by the backend at
#   container creation (apps/server/src/modules/containers/dockerRuntime.ts).

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TERM=xterm-256color

# Tools students are expected to use. coreutils, findutils, grep, util-linux
# (more, whereis), debianutils (which) and bash are already in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash-completion \
      file \
      less \
      nano \
      procps \
      psmisc \
      sudo \
      tree \
      vim-tiny \
 && rm -rf /var/lib/apt/lists/*

# Replace the base image's default `ubuntu` user with `student`.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd --create-home --uid 1000 --shell /bin/bash student \
 && passwd --lock student \
 && passwd --lock root \
 && mkdir -p /home/student/Documents /home/student/Downloads /home/student/Desktop \
 && chown -R student:student /home/student

# Admin exercises: passwordless sudo for the student (students have no password).
RUN printf 'student ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/student \
 && chmod 0440 /etc/sudoers.d/student \
 && visudo -c

# Remove every setuid/setgid bit (su, passwd, mount, ...) except sudo's.
# Without the per-exam sudo setting, no-new-privileges blocks sudo too.
RUN find / -xdev -perm /6000 -type f ! -path /usr/bin/sudo -exec chmod a-s {} + || true

# Command logging hook (root-owned, read-only for the student), loaded by
# every interactive bash via the system-wide bashrc. Ubuntu's default
# HISTCONTROL=ignoreboth is removed because it would hide repeated commands.
RUN install -d -o root -g root -m 0755 /etc/linuxlab
COPY --chown=root:root --chmod=0644 command-hook.sh /etc/linuxlab/command-hook.sh
RUN printf '\n# Linux Lab command logging\n. /etc/linuxlab/command-hook.sh\n' >> /etc/bash.bashrc \
 && sed -i '/^HISTCONTROL=/d' /etc/skel/.bashrc /home/student/.bashrc

LABEL org.linuxlab.image="student-ubuntu" \
      org.linuxlab.version="3"

USER student
WORKDIR /home/student

# Keeps the container alive; the backend attaches a Bash shell via `docker exec`.
CMD ["sleep", "infinity"]
