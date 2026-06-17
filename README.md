# O.T.T.O (Orchestrated Task & Tool Operator)

O.T.T.O is a powerful, terminal-based AI assistant and autonomous agent. Designed to run directly in your workspace, O.T.T.O combines large language models with native system tools, giving you a full-featured AI coding partner, terminal executor, and workspace manager accessible through a beautiful, mobile-OS-inspired terminal interface.

---

## ✨ Features

- **Agentic Capabilities & Tools**: O.T.T.O doesn't just chat; it *acts*. It can execute terminal commands, read/write files, parse diffs, and inspect your environment autonomously to solve complex tasks.
- **Multi-Model & Multi-Provider**: Support for Groq, OpenAI, Anthropic, and Ollama (local). Seamlessly switch between models and providers on the fly.
- **Beautiful TUI (Terminal User Interface)**: A smooth, interactive "PhoneOS" menu system for navigating settings, tools, and threads, complete with full keyboard navigation.
- **Interactive Git Dashboard**: A visual git client built right in. Stage files, commit, switch branches, push/pull, and view a **beautiful color-coded commit graph** right from the terminal.
- **Persistent Sessions**: Chat threads are automatically saved and restored using a local SQLite database. A built-in resource manager prevents CPU bloat by allowing you to set a `Max Threads` limit.
- **Rich Streaming Chat**: Responses stream in real-time within an alternate terminal screen buffer—meaning long chats won't pollute your primary terminal scrollback. Navigate chat history effortlessly with an internal viewport scroller.
- **Configurable Security Modes**: Stay in control. Choose between `Full` autonomy, `Approve` (O.T.T.O asks before running commands), or `Ask` mode.
- **Personalized**: Set your profile name so O.T.T.O can address you naturally. 

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- [Git](https://git-scm.com/)

### Installation

The easiest way to install O.T.T.O globally on your system is via NPM:
```bash
npm install -g @dpv007/otto-cli
```
Once installed, simply type `otto` in your terminal to launch the dashboard!

---

### Installing from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Dedeep007/O.T.T.O.git
   cd O.T.T.O
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run O.T.T.O:**
   ```bash
   npm start
   ```


## ⚙️ Configuration

O.T.T.O stores its configuration in a local `.ottorc` file in your home directory. Upon first launch, you will be prompted to:
1. Set up a default **Profile Username**.
2. Add an API Key for your preferred provider (Groq, OpenAI, Anthropic, or Ollama).

All settings can be dynamically managed directly from the **Settings & Security** menu inside the TUI.

## 🛠️ Built-In Dashboards

O.T.T.O comes with several built-in modules designed to keep you inside the terminal:

- **Git Dashboard**: Press `Escape` while in chat to access the menu, then navigate to the Git Dashboard. From here you can manage your working tree, stage files, commit, and view the visual commit tree (`◈ Commit Graph`).
- **Task Board**: Maintain a visual Kanban board to track your current project tasks.
- **File Explorer**: Browse your local workspace files directly from the TUI.

## 🛡️ Security

Because O.T.T.O can run shell commands and modify your filesystem, it includes a robust Security Guardrail system:
- **Ask Mode**: O.T.T.O will prompt for explicit permission before doing anything that modifies your system.
- **Approve Mode**: O.T.T.O will show you the exact command it plans to run and require a `Y/n` confirmation.
- **Full Mode**: Unleash O.T.T.O to execute commands and scripts fully autonomously.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Dedeep007/O.T.T.O/issues).

---

*O.T.T.O — Orchestrated Task & Tool Operator*