require("dotenv").config({ silent: true });
const axios = require("axios");
const inquirer = require("inquirer").default;
const WebSocket = require("ws");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const FormData = require("form-data");
const chalk = require("chalk").default;
const Table = require("cli-table3");

// --- GLOBAL CONFIG & LANGUAGE ---
let config = {};
let lang = {};
const CONFIG_PATH = path.join(__dirname, "config.json");

// --- PTERODACTYL API CONFIG ---
let PANEL_URL = process.env.PTERO_URL;
let API_KEY = process.env.PTERO_KEY;
// --------------------------------

let api; // Will be initialized after config validation.
let ws; // WebSocket connection

async function validateAndPromptEnv() {
  let envFile = "";
  const envPath = path.join(__dirname, ".env");

  if (!PANEL_URL || !API_KEY) {
    console.log(
      chalk.yellow("Pterodactyl API configuration not found. Let's set it up."),
    );

    // Read existing .env file if it exists
    if (fs.existsSync(envPath)) envFile = fs.readFileSync(envPath, "utf8");
  }

  if (!PANEL_URL) {
    const { ptero_url } = await inquirer.prompt({
      type: "input",
      name: "ptero_url",
      message:
        "Enter your Pterodactyl panel URL (e.g., https://panel.example.com):",
      validate: function (value) {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "Please enter a valid HTTP/HTTPS URL.";
          }
          return true;
        } catch (error) {
          return "Please enter a valid URL.";
        }
      },
    });
    const urlObject = new URL(ptero_url);
    PANEL_URL = urlObject.origin;
    envFile += `\nPTERO_URL=${PANEL_URL}`;
  }
  if (!API_KEY) {
    const { ptero_key } = await inquirer.prompt({
      type: "input",
      name: "ptero_key",
      message: "Enter your Pterodactyl client API Key:",
      validate: function (value) {
        if (value && value.trim().length) {
          return true;
        }
        return "API Key cannot be empty.";
      },
    });
    API_KEY = ptero_key;
    envFile += `\nPTERO_KEY=${API_KEY}`;
  }

  if (envFile) {
    fs.writeFileSync(envPath, envFile);

    // Update current process's env for the current session
    process.env.PTERO_URL = PANEL_URL;
    process.env.PTERO_KEY = API_KEY;

    console.log(chalk.green("✅ Configuration saved to .env file."));
  }
  // Initialize the API client with the (potentially new) credentials
  api = axios.create({
    baseURL: `${PANEL_URL}/api/client`,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json",
    },
  });
}

// --- LANGUAGE & CONFIG FUNCTIONS ---

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const rawConfig = fs.readFileSync(CONFIG_PATH);
    config = JSON.parse(rawConfig);
  } else {
    config = { language: "en", editor: "nano" };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }
}

function loadLanguage() {
  const langPath = path.join(__dirname, "lang", `${config.language}.json`);
  if (fs.existsSync(langPath)) {
    const rawLang = fs.readFileSync(langPath);
    lang = JSON.parse(rawLang);
  } else {
    console.error(
      chalk.red.bold(
        `Language file ${config.language}.json not found! Falling back to English.`,
      ),
    );
    const enPath = path.join(__dirname, "en.json");
    if (fs.existsSync(enPath)) {
      const rawEn = fs.readFileSync(enPath);
      lang = JSON.parse(rawEn);
    } else {
      // Fallback
      lang = {
        menus: { actions: { exit: "Exit" } },
        messages: { goodbye: "Goodbye!" },
      };
    }
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function settingsMenu() {
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: chalk.bold(lang.settings.menu_title),
      choices: [
        {
          name: `${lang.settings.language} (${config.language})`,
          value: "lang",
        },
        { name: `${lang.settings.editor} (${config.editor})`, value: "editor" },
        new inquirer.Separator(),
        { name: lang.settings.back, value: "back" },
      ],
    },
  ]);

  if (choice === "lang") {
    const { newLang } = await inquirer.prompt([
      {
        type: "list",
        name: "newLang",
        message: lang.settings.change_language_prompt,
        choices: ["id", "en"],
      },
    ]);
    config.language = newLang;
    saveConfig();
    loadLanguage();
    console.log(chalk.green(lang.settings.language_changed));
  } else if (choice === "editor") {
    const { newEditor } = await inquirer.prompt([
      {
        type: "list",
        name: "newEditor",
        message: lang.settings.change_editor_prompt,
        choices: ["nano", "vim", "nvim", "acode"],
      },
    ]);
    config.editor = newEditor;
    saveConfig();
    console.log(
      chalk.green(
        lang.settings.editor_changed.replace("{editor}", config.editor),
      ),
    );
  }
}

// --- CORE APPLICATION FLOW ---

async function main() {
  loadConfig();
  loadLanguage();
  await validateAndPromptEnv();

  while (true) {
    try {
      let serverInfo = await selectServer();

      if (serverInfo === "settings") {
        await settingsMenu();
        continue; // Loop back to server selection
      }

      if (!serverInfo) {
        console.log(chalk.cyan(lang.messages.goodbye));
        return; // Exit the program
      }

      let backToServerSelection = false;
      while (!backToServerSelection) {
        await displayServerStatus(serverInfo.id);
        const action = await selectAction(serverInfo.name);

        switch (action) {
          case "start":
          case "stop":
          case "restart":
          case "kill":
            await sendPowerAction(serverInfo.id, action);
            console.log(chalk.yellow(lang.messages.waiting_for_status_update));
            await new Promise((resolve) => setTimeout(resolve, 5000));
            break;

          case "console":
            await connectToConsole(serverInfo.id);
            break;

          case "file-manager":
            await fileManagerMenu(serverInfo.id);
            break;

          case "change-server":
            backToServerSelection = true;
            break;

          case "exit":
            console.log(chalk.cyan(lang.messages.goodbye));
            return;
        }
      }
    } catch (error) {
      console.error(
        chalk.red.bold(
          lang.messages.fatal_error.replace("{error}", error.message),
        ),
      );
      return;
    }
  }
}

async function selectServer() {
  console.log(chalk.yellow(lang.messages.fetching_servers));
  const { data: serverList } = await api.get("/");

  const serverChoices = serverList.data.map((server) => ({
    name: `${server.attributes.name} (${chalk.gray(server.attributes.identifier.substring(0, 8))})`,
    value: { id: server.attributes.identifier, name: server.attributes.name },
  }));

  if (serverChoices.length === 0) {
    console.log(chalk.red(lang.messages.no_servers_found));
    return null;
  }

  serverChoices.push(
    new inquirer.Separator(),
    { name: lang.menus.actions.settings, value: "settings" },
    { name: lang.menus.actions.exit, value: null },
  );

  const { selectedServer } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedServer",
      message: chalk.bold(lang.menus.server_select_prompt),
      choices: serverChoices,
    },
  ]);

  if (selectedServer && selectedServer !== "settings") {
    console.log(
      chalk.green(
        lang.messages.server_selected.replace(
          "{serverName}",
          chalk.bold(selectedServer.name),
        ),
      ),
    );
  }
  return selectedServer;
}

async function selectAction(serverName) {
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: chalk.bold(
        lang.menus.main_prompt.replace("{serverName}", chalk.cyan(serverName)),
      ),
      choices: [
        { name: lang.menus.actions.console, value: "console" },
        { name: lang.menus.actions.file_manager, value: "file-manager" },
        new inquirer.Separator(),
        { name: chalk.green(lang.menus.actions.start), value: "start" },
        { name: chalk.red(lang.menus.actions.stop), value: "stop" },
        { name: chalk.yellow(lang.menus.actions.restart), value: "restart" },
        { name: chalk.magenta(lang.menus.actions.kill), value: "kill" },
        new inquirer.Separator(),
        { name: lang.menus.actions.change_server, value: "change-server" },
        { name: lang.menus.actions.exit, value: "exit" },
      ],
    },
  ]);
  return action;
}

async function displayServerStatus(serverId) {
  try {
    console.log(chalk.yellow(lang.messages.fetching_status));
    const { data } = await api.get(`/servers/${serverId}/resources`);
    const status = data.attributes;
    const currentState = status.current_state;

    const table = new Table({
      head: [
        chalk.cyan.bold(lang.status.metric_header_metric),
        chalk.cyan.bold(lang.status.metric_header_value),
      ],
      colWidths: [18, 50],
      chars: {
        top: "═",
        "top-mid": "╤",
        "top-left": "╔",
        "top-right": "╗",
        bottom: "═",
        "bottom-mid": "╧",
        "bottom-left": "╚",
        "bottom-right": "╝",
        left: "║",
        "left-mid": "╟",
        mid: "─",
        "mid-mid": "┼",
        right: "║",
        "right-mid": "╢",
        middle: "│",
      },
    });

    let stateText;
    switch (currentState) {
      case "running":
        stateText = chalk.green.bold(lang.status.running);
        break;
      case "offline":
        stateText = chalk.red.bold(lang.status.offline);
        break;
      case "starting":
        stateText = chalk.yellow.bold(lang.status.starting);
        break;
      default:
        stateText = chalk.gray(currentState);
    }
    table.push([chalk.bold(lang.status.metric_status), stateText]);

    if (currentState !== "offline") {
      const uptimeMs = status.resources.uptime;
      let uptimeStr = "N/A";
      if (uptimeMs > 0) {
        let totalSeconds = Math.floor(uptimeMs / 1000);
        const days = Math.floor(totalSeconds / (24 * 3600));
        totalSeconds %= 24 * 3600;
        const hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        uptimeStr = [
          days > 0 && `${days}d`,
          hours > 0 && `${hours}h`,
          minutes > 0 && `${minutes}m`,
          `${seconds}s`,
        ]
          .filter(Boolean)
          .join(" ");
      }
      table.push([chalk.bold(lang.status.metric_uptime), uptimeStr]);

      const cpuUsage = `${status.resources.cpu_absolute.toFixed(2)}%`;
      const memoryBytes = status.resources.memory_bytes;
      const memoryLimitBytes = status.limits?.memory * 1024 * 1024 || 0;
      const memoryUsage =
        memoryLimitBytes > 0 ? (memoryBytes / memoryLimitBytes) * 100 : 0;
      const ram = `${(memoryBytes / 1024 / 1024).toFixed(2)} MB / ${status.limits?.memory || "N/A"} MB (${memoryUsage.toFixed(2)}%)`;

      const diskBytes = status.resources.disk_bytes;
      const diskLimitBytes = status.limits?.disk * 1024 * 1024 || 0;
      const diskUsage =
        diskLimitBytes > 0 ? (diskBytes / diskLimitBytes) * 100 : 0;
      const disk = `${(diskBytes / 1024 / 1024).toFixed(2)} MB / ${status.limits?.disk || "N/A"} MB (${diskUsage.toFixed(2)}%)`;

      table.push(
        [chalk.bold(lang.status.metric_cpu), chalk.yellow(cpuUsage)],
        [chalk.bold(lang.status.metric_ram), chalk.blue(ram)],
        [chalk.bold(lang.status.metric_disk), chalk.magenta(disk)],
      );
    }

    console.log(table.toString() + "\n");
  } catch (error) {
    const errorMsg = error.response?.data?.errors?.[0]?.detail || error.message;
    console.error(
      chalk.red(
        lang.messages.status_fetch_error.replace("{error}", errorMsg) + "\n",
      ),
    );
  }
}

async function sendPowerAction(serverId, signal) {
  const message = `${lang.messages.power_actions[signal]} server...`;
  console.log(chalk.yellow(`⏳ ${message}`));
  try {
    await api.post(`/servers/${serverId}/power`, { signal });
    console.log(chalk.green(lang.messages.power_action_sent));
  } catch (error) {
    const errorMsg = error.response?.data?.errors?.[0]?.detail || error.message;
    console.error(
      chalk.red(lang.messages.power_action_fail.replace("{error}", errorMsg)),
    );
  }
}

// --- FILE MANAGER FUNCTIONS ---

async function fileManagerMenu(serverId) {
  let currentPath = "/";
  while (true) {
    try {
      const items = await listDirectory(serverId, currentPath);
      const choices = [
        new inquirer.Separator(),
        { name: lang.fileManager.back_to_main_menu, value: { action: "exit" } },
        { name: lang.fileManager.upload_file, value: { action: "upload" } },
        {
          name: lang.fileManager.create_directory,
          value: { action: "create-dir" },
        },
        {
          name: lang.fileManager.archive_selected,
          value: { action: "archive-selected" },
        },
        {
          name: lang.fileManager.batch_delete,
          value: { action: "batch-delete" },
        },
        {
          name: lang.fileManager.batch_move,
          value: { action: "batch-move" },
        },
        {
          name: lang.fileManager.batch_copy,
          value: { action: "batch-copy" },
        },
      ];
      if (currentPath !== "/") {
        choices.push({ name: lang.fileManager.go_up, value: { action: "up" } });
      }
      choices.push(new inquirer.Separator());

      items.dirs.forEach((dir) =>
        choices.push({
          name: `📁 ${dir.name}`,
          value: { action: "dir", item: dir },
        }),
      );
      items.files.forEach((file) =>
        choices.push({
          name: `📄 ${file.name}`,
          value: { action: "file", item: file },
        }),
      );

      const { selected } = await inquirer.prompt([
        {
          type: "list",
          name: "selected",
          message: chalk.bold(
            lang.fileManager.title.replace("{path}", chalk.cyan(currentPath)),
          ),
          choices: choices,
          pageSize: 20,
        },
      ]);

      switch (selected.action) {
        case "exit":
          return;
        case "up":
          currentPath = path.dirname(currentPath);
          break;
        case "dir":
          const dirAction = await handleDirAction(
            serverId,
            currentPath,
            selected.item,
          );
          if (dirAction.action === "open") currentPath = dirAction.newPath;
          break;
        case "file":
          await handleFileAction(serverId, currentPath, selected.item);
          break;
        case "upload":
          await uploadFile(serverId, currentPath);
          break;
        case "create-dir":
          await createDirectory(serverId, currentPath);
          break;
        case "archive-selected":
          await archiveSelectedItems(serverId, currentPath, items);
          break;
        case "batch-delete":
          await batchDelete(serverId, currentPath, items);
          break;
        case "batch-move":
          await batchMove(serverId, currentPath, items);
          break;
        case "batch-copy":
          await batchCopy(serverId, currentPath, items);
          break;
      }
    } catch (error) {
      console.error(
        chalk.red(lang.fileManager.error.replace("{error}", error.message)),
      );
      return;
    }
  }
}

async function handleDirAction(serverId, currentPath, dir) {
  const dirPath = path.join(currentPath, dir.name);
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: lang.fileManager.dir_actions_prompt.replace(
        "{dirName}",
        chalk.cyan(dir.name),
      ),
      choices: [
        { name: lang.fileManager.open, value: "open" },
        { name: lang.fileManager.copy, value: "copy" },
        { name: lang.fileManager.move, value: "move" },
        { name: lang.fileManager.archive || "Archive", value: "archive" },
        { name: lang.fileManager.rename, value: "rename" },
        { name: chalk.red(lang.fileManager.delete), value: "delete" },
        new inquirer.Separator(),
        { name: lang.fileManager.cancel, value: "cancel" },
      ],
    },
  ]);
  if (action === "open") return { action: "open", newPath: dirPath };
  if (action === "copy") await copyItem(serverId, currentPath, dir);
  if (action === "move") await moveItem(serverId, currentPath, dir);
  if (action === "archive") await archiveItem(serverId, currentPath, dir);
  if (action === "rename") await renameItem(serverId, currentPath, dir);
  if (action === "delete") await deleteItem(serverId, dirPath);
  return { action: "stay" };
}

async function handleFileAction(serverId, currentPath, file) {
  const filePath = path.join(currentPath, file.name);
  const choices = [
    { name: lang.fileManager.edit_file, value: "edit" },
    { name: lang.fileManager.view_content, value: "view" },
    { name: lang.fileManager.download, value: "download" },
    { name: lang.fileManager.copy, value: "copy" },
    { name: lang.fileManager.move, value: "move" },
  ];

  // Add extract option for supported archive types
  if (/\.(zip|tar\.gz|tar|rar)$/.test(file.name)) {
    choices.push({
      name: lang.fileManager.extract || "Extract",
      value: "extract",
    });
  }

  choices.push(
    { name: lang.fileManager.rename, value: "rename" },
    { name: chalk.red(lang.fileManager.delete), value: "delete" },
    new inquirer.Separator(),
    { name: lang.fileManager.cancel, value: "cancel" },
  );

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: lang.fileManager.file_actions_prompt.replace(
        "{fileName}",
        chalk.cyan(file.name),
      ),
      choices,
    },
  ]);

  switch (action) {
    case "edit":
      await editFile(serverId, filePath);
      break;
    case "view":
      await viewFile(serverId, filePath);
      break;
    case "download":
      await downloadFile(serverId, filePath);
      break;
    case "copy":
      await copyItem(serverId, currentPath, file);
      break;
    case "move":
      await moveItem(serverId, currentPath, file);
      break;
    case "extract":
      await extractFile(serverId, currentPath, file);
      break;
    case "rename":
      await renameItem(serverId, currentPath, file);
      break;
    case "delete":
      await deleteItem(serverId, filePath);
      break;
    case "cancel":
    default:
      // Do nothing
      break;
  }
}

async function editFile(serverId, filePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pterocli-"));
  const localPath = path.join(tempDir, path.basename(filePath));

  try {
    await downloadFile(serverId, filePath, localPath, true);

    console.log(
      chalk.yellow(
        lang.fileManager.editing_file
          .replace("{file}", filePath)
          .replace("{editor}", config.editor),
      ),
    );
    const editorProcess = spawnSync(config.editor, [localPath], {
      stdio: "inherit",
    });

    if (editorProcess.error) {
      throw new Error(
        lang.fileManager.editor_start_fail.replace("{editor}", config.editor),
      );
    }

    const { confirmUpload } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmUpload",
        message: lang.fileManager.edit_upload_confirm,
        default: true,
      },
    ]);

    if (confirmUpload) {
      console.log(chalk.yellow(lang.fileManager.edit_uploading));
      await uploadFile(serverId, path.dirname(filePath), localPath, true);
      console.log(chalk.green(lang.fileManager.edit_complete));
    } else {
      console.log(
        chalk.yellow(
          lang.fileManager.edit_cancelled.replace("{tempPath}", localPath),
        ),
      );
    }
  } catch (error) {
    console.error(chalk.red(`❌ ${error.message}`));
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function viewFile(serverId, filePath) {
  try {
    console.log(
      chalk.yellow(
        lang.fileManager.fetching_content.replace("{file}", filePath),
      ),
    );
    const { data } = await api.get(
      `/servers/${serverId}/files/contents?file=${encodeURIComponent(filePath)}`,
    );
    console.log(
      chalk.cyan.bold(
        lang.fileManager.content_header.replace("{file}", filePath),
      ),
    );
    console.log(data);
    console.log(chalk.cyan.bold(lang.fileManager.content_footer));
    await inquirer.prompt([
      {
        type: "input",
        name: "enter",
        message: lang.fileManager.continue_prompt,
      },
    ]);
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.view_content_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function listDirectory(serverId, directory) {
  try {
    console.log(
      chalk.yellow(lang.fileManager.listing_dir.replace("{dir}", directory)),
    );
    const { data } = await api.get(
      `/servers/${serverId}/files/list?directory=${encodeURIComponent(directory)}`,
    );
    const dirs = data.data
      .filter((item) => !item.attributes.is_file)
      .map((item) => item.attributes);
    const files = data.data
      .filter((item) => item.attributes.is_file)
      .map((item) => item.attributes);
    return { dirs, files };
  } catch (error) {
    throw new Error(
      lang.fileManager.list_dir_error.replace(
        "{error}",
        error.response?.data?.errors?.[0]?.detail || error.message,
      ),
    );
  }
}

async function uploadFile(
  serverId,
  currentPath,
  localFilePath,
  silent = false,
) {
  try {
    let filePath = localFilePath;
    if (!filePath) {
      const { promptedPath } = await inquirer.prompt([
        {
          type: "input",
          name: "promptedPath",
          message: lang.fileManager.upload_prompt,
        },
      ]);
      filePath = promptedPath;
    }

    if (!filePath || !fs.existsSync(filePath)) {
      console.error(chalk.red(lang.fileManager.upload_file_not_found));
      return;
    }

    if (!silent) console.log(chalk.yellow(lang.fileManager.upload_getting_url));
    const { data } = await api.get(
      `/servers/${serverId}/files/upload?directory=${encodeURIComponent(currentPath)}`,
    );
    const uploadUrl = data.attributes.url;
    const form = new FormData();
    const fileName = path.basename(filePath);
    form.append("files", fs.createReadStream(filePath), { filename: fileName });
    if (!silent)
      console.log(
        chalk.yellow(
          lang.fileManager.uploading_file.replace("{fileName}", fileName),
        ),
      );
    await axios.post(uploadUrl, form, {
      headers: { ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (!silent)
      console.log(
        chalk.green(
          lang.fileManager.upload_success
            .replace("{fileName}", fileName)
            .replace("{path}", currentPath),
        ),
      );
  } catch (error) {
    throw new Error(
      lang.fileManager.upload_fail.replace(
        "{error}",
        error.response?.data?.errors?.[0]?.detail || error.message,
      ),
    );
  }
}

async function downloadFile(serverId, filePath, localSavePath, silent = false) {
  try {
    const savePath = localSavePath || path.basename(filePath);
    if (!silent)
      console.log(
        chalk.yellow(
          lang.fileManager.download_getting_url.replace("{filePath}", filePath),
        ),
      );
    const { data } = await api.get(
      `/servers/${serverId}/files/download?file=${encodeURIComponent(filePath)}`,
    );
    const writer = fs.createWriteStream(savePath);
    if (!silent) console.log(chalk.yellow(lang.fileManager.downloading_file));
    const response = await axios.get(data.attributes.url, {
      responseType: "stream",
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        if (!silent)
          console.log(
            chalk.green(
              lang.fileManager.download_success.replace("{fileName}", savePath),
            ),
          );
        resolve();
      });
      writer.on("error", (err) =>
        reject(
          new Error(
            lang.fileManager.download_fail.replace("{error}", err.message),
          ),
        ),
      );
    });
  } catch (error) {
    throw new Error(
      lang.fileManager.download_url_error.replace(
        "{error}",
        error.response?.data?.errors?.[0]?.detail || error.message,
      ),
    );
  }
}

async function renameItem(serverId, currentPath, item) {
  try {
    const { newName } = await inquirer.prompt([
      {
        type: "input",
        name: "newName",
        message: lang.fileManager.rename_prompt.replace("{name}", item.name),
        default: item.name,
      },
    ]);
    if (newName && newName !== item.name) {
      console.log(chalk.yellow(lang.fileManager.renaming));
      await api.put(`/servers/${serverId}/files/rename`, {
        root: currentPath,
        files: [{ from: item.name, to: newName }],
      });
      console.log(chalk.green(lang.fileManager.rename_success));
    }
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.rename_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function createDirectory(serverId, currentPath) {
  try {
    const { dirName } = await inquirer.prompt([
      {
        type: "input",
        name: "dirName",
        message: lang.fileManager.create_dir_prompt,
      },
    ]);
    if (dirName) {
      console.log(chalk.yellow(lang.fileManager.creating_dir));
      await api.post(`/servers/${serverId}/files/create-folder`, {
        root: currentPath,
        name: dirName,
      });
      console.log(chalk.green(lang.fileManager.create_dir_success));
    }
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.create_dir_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function deleteItem(serverId, itemPath) {
  try {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: lang.fileManager.delete_confirm.replace(
          "{item}",
          chalk.yellow.bold(itemPath),
        ),
        default: false,
      },
    ]);
    if (confirm) {
      console.log(chalk.yellow(lang.fileManager.deleting_item));
      await api.post(`/servers/${serverId}/files/delete`, {
        root: "/",
        files: [itemPath.startsWith("/") ? itemPath.substring(1) : itemPath],
      });
      console.log(chalk.green(lang.fileManager.delete_success));
    } else {
      console.log(lang.fileManager.delete_cancelled);
    }
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.delete_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function archiveItem(serverId, currentPath, item) {
  try {
    const itemPath = path.join(currentPath, item.name);
    console.log(
      chalk.yellow(
        lang.fileManager.archiving_item.replace("{item}", item.name),
      ),
    );
    await api.post(`/servers/${serverId}/files/compress`, {
      root: currentPath,
      files: [item.name],
    });
    console.log(chalk.green(lang.fileManager.archive_success));
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.archive_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function archiveSelectedItems(serverId, currentPath, items) {
  const allItems = [
    ...items.dirs.map((d) => ({ name: `📁 ${d.name}`, value: d.name })),
    ...items.files.map((f) => ({ name: `📄 ${f.name}`, value: f.name })),
  ];

  if (allItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_to_archive));
    return;
  }

  const { selectedItems } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedItems",
      message: lang.fileManager.select_items_to_archive,
      choices: allItems,
      pageSize: 15,
    },
  ]);

  if (selectedItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.archive_selection_cancelled));
    return;
  }

  try {
    console.log(chalk.yellow(lang.fileManager.archiving_selected_items));
    await api.post(`/servers/${serverId}/files/compress`, {
      root: currentPath,
      files: selectedItems,
    });
    console.log(chalk.green(lang.fileManager.archive_success));
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.archive_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function extractFile(serverId, currentPath, file) {
  try {
    const filePath = path.join(currentPath, file.name);
    console.log(
      chalk.yellow(
        lang.fileManager.extracting_file.replace("{file}", file.name),
      ),
    );
    await api.post(`/servers/${serverId}/files/decompress`, {
      root: currentPath,
      file: file.name,
    });
    console.log(chalk.green(lang.fileManager.extract_success));
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.extract_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function copyItem(serverId, currentPath, item, silent = false) {
  try {
    let confirm = true;
    if (!silent) {
      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: lang.fileManager.copy_confirm.replace(
            "{item}",
            chalk.yellow.bold(item.name),
          ),
          default: true,
        },
      ]);
      confirm = confirmed;
    }

    if (confirm) {
      console.log(
        chalk.yellow(
          lang.fileManager.copying_item.replace("{item}", item.name),
        ),
      );
      await api.post(`/servers/${serverId}/files/copy`, {
        location: path.join(currentPath, item.name),
      });
      if (!silent) {
        console.log(chalk.green(lang.fileManager.copy_success));
      }
    } else {
      if (!silent) {
        console.log(lang.fileManager.copy_cancelled);
      }
    }
    return true;
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.copy_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
    return false;
  }
}

async function moveItem(serverId, currentPath, item) {
  try {
    const { newPath } = await inquirer.prompt([
      {
        type: "input",
        name: "newPath",
        message: lang.fileManager.move_prompt.replace("{name}", item.name),
        default: currentPath,
      },
    ]);

    if (newPath) {
      console.log(
        chalk.yellow(lang.fileManager.moving_item.replace("{item}", item.name)),
      );
      await api.put(`/servers/${serverId}/files/rename`, {
        root: "/",
        files: [
          {
            from: path.join(currentPath, item.name),
            to: path.join(newPath, item.name),
          },
        ],
      });
      console.log(chalk.green(lang.fileManager.move_success));
    }
  } catch (error) {
    console.error(
      chalk.red(
        lang.fileManager.move_fail.replace(
          "{error}",
          error.response?.data?.errors?.[0]?.detail || error.message,
        ),
      ),
    );
  }
}

async function batchDelete(serverId, currentPath, items) {
  const allItems = [
    ...items.dirs.map((d) => ({ name: `📁 ${d.name}`, value: d.name })),
    ...items.files.map((f) => ({ name: `📄 ${f.name}`, value: f.name })),
  ];

  if (allItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { selectedItems } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedItems",
      message: lang.fileManager.select_items_to_delete,
      choices: allItems,
      pageSize: 15,
    },
  ]);

  if (selectedItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { confirm } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirm",
      message: lang.fileManager.batch_delete_confirm.replace(
        "{count}",
        selectedItems.length,
      ),
      default: false,
    },
  ]);

  if (confirm) {
    try {
      console.log(chalk.yellow(lang.fileManager.deleting_item));
      await api.post(`/servers/${serverId}/files/delete`, {
        root: currentPath,
        files: selectedItems,
      });
      console.log(
        chalk.green(
          lang.fileManager.batch_delete_success.replace(
            "{count}",
            selectedItems.length,
          ),
        ),
      );
    } catch (error) {
      console.error(
        chalk.red(
          lang.fileManager.batch_delete_fail.replace(
            "{error}",
            error.response?.data?.errors?.[0]?.detail || error.message,
          ),
        ),
      );
    }
  } else {
    console.log(lang.fileManager.delete_cancelled);
  }
}

async function batchMove(serverId, currentPath, items) {
  const allItems = [
    ...items.dirs.map((d) => ({ name: `📁 ${d.name}`, value: d.name })),
    ...items.files.map((f) => ({ name: `📄 ${f.name}`, value: f.name })),
  ];

  if (allItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { selectedItems } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedItems",
      message: lang.fileManager.select_items_to_move,
      choices: allItems,
      pageSize: 15,
    },
  ]);

  if (selectedItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { newPath } = await inquirer.prompt([
    {
      type: "input",
      name: "newPath",
      message: lang.fileManager.batch_move_prompt,
      default: currentPath,
    },
  ]);

  if (newPath) {
    try {
      console.log(
        chalk.yellow(
          lang.fileManager.moving_item.replace("{item}", selectedItems.length),
        ),
      );
      const files = selectedItems.map((item) => ({
        from: path.join(currentPath, item),
        to: path.join(newPath, item),
      }));
      await api.put(`/servers/${serverId}/files/rename`, {
        root: "/",
        files,
      });
      console.log(
        chalk.green(
          lang.fileManager.batch_move_success.replace(
            "{count}",
            selectedItems.length,
          ),
        ),
      );
    } catch (error) {
      console.error(
        chalk.red(
          lang.fileManager.batch_move_fail.replace(
            "{error}",
            error.response?.data?.errors?.[0]?.detail || error.message,
          ),
        ),
      );
    }
  }
}

async function batchCopy(serverId, currentPath, items) {
  const allItems = [
    ...items.dirs.map((d) => ({
      name: `📁 ${d.name}`,
      value: { name: d.name, is_file: false },
    })),
    ...items.files.map((f) => ({
      name: `📄 ${f.name}`,
      value: { name: f.name, is_file: true },
    })),
  ];

  if (allItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { selectedItems } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedItems",
      message: lang.fileManager.select_items_to_copy,
      choices: allItems,
      pageSize: 15,
    },
  ]);

  if (selectedItems.length === 0) {
    console.log(chalk.yellow(lang.fileManager.no_items_selected));
    return;
  }

  const { newPath } = await inquirer.prompt([
    {
      type: "input",
      name: "newPath",
      message: lang.fileManager.batch_move_prompt, // Using the same prompt for destination
      default: currentPath,
    },
  ]);

  if (newPath) {
    let successCount = 0;
    let failCount = 0;

    for (const item of selectedItems) {
      // 1. Copy item to the same directory first
      const copied = await copyItem(serverId, currentPath, item, true);
      if (copied) {
        // 2. Move the copied item to the new path
        const newName = item.name;
        const fromPath = path.join(currentPath, `copy_of_${newName}`);
        const toPath = path.join(newPath, newName);
        try {
          await api.put(`/servers/${serverId}/files/rename`, {
            root: "/",
            files: [{ from: fromPath, to: toPath }],
          });
          successCount++;
        } catch (e) {
          failCount++;
          console.error(chalk.red(`Failed to move ${fromPath} to ${toPath}`));
        }
      } else {
        failCount++;
      }
    }

    if (failCount > 0) {
      console.error(chalk.red(`${failCount} items failed to copy.`));
    }
    if (successCount > 0) {
      console.log(
        chalk.green(
          lang.fileManager.batch_copy_success.replace("{count}", successCount),
        ),
      );
    }
  }
}

// --- CONSOLE FUNCTIONS ---

function connectToConsole(serverId) {
  return new Promise(async (resolve) => {
    console.log(chalk.yellow(lang.console.connecting));
    const { data } = await api.get(`/servers/${serverId}/websocket`);
    ws = new WebSocket(data.data.socket, { origin: PANEL_URL });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan("> "),
    });

    // --- DEBOUNCING LOGIC FOR SMOOTH RENDERING ---
    let messageBuffer = [];
    let redrawTimer = null;

    ws.on("open", () => {
      console.log(chalk.green(lang.console.connected));
      // Send auth token
      ws.send(JSON.stringify({ event: "auth", args: [data.data.token] }));

      console.log(chalk.cyan.bold(lang.console.waiting_for_logs));
      console.log(
        chalk.cyan.bold(
          "\n----------------------------------------------------",
        ),
      );
      console.log(chalk.bold(lang.console.exit_instruction));
      rl.prompt();
    });

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);

        // Ignore status updates completely
        if (message.event === "status") {
          return;
        }

        if (message.event === "console output") {
          messageBuffer.push(message.args[0]);
        }
      } catch (e) {
        // Buffer non-JSON data as well (e.g., startup logs)
        messageBuffer.push(data.toString());
      }

      // If a redraw is already scheduled, cancel it.
      if (redrawTimer) {
        clearTimeout(redrawTimer);
      }

      // Schedule a redraw in 50ms.
      redrawTimer = setTimeout(() => {
        if (messageBuffer.length > 0) {
          // Clear the user's current line
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 1);

          // Write all buffered messages in one go
          process.stdout.write(messageBuffer.join(""));

          // Add a newline if the last message didn't have one
          if (!messageBuffer[messageBuffer.length - 1].endsWith("\n")) {
            process.stdout.write("\n");
          }

          // Clear the buffer
          messageBuffer = [];
        }

        // Redraw the prompt
        rl.prompt(true);
      }, 50);
    });

    ws.on("error", (error) => {
      console.error(
        chalk.red(
          lang.console.connection_error.replace("{error}", error.message),
        ),
      );
      rl.close();
      resolve();
    });

    ws.on("close", () => {
      console.log(chalk.cyan.bold(lang.console.connection_closed));
      rl.close();
      resolve();
    });

    rl.on("line", (line) => {
      const command = line.trim();
      if (command.toLowerCase() === "!exit") {
        ws.close();
      } else if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "send command", args: [command] }));
        rl.prompt();
      }
    }).on("close", () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  });
}

main();
