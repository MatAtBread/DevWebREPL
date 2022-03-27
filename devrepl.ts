(function(exports){
enum Wait {
  Connect = 'red',
  Prompt = 'blue',
  Echo = 'green',
  Result = 'black',
  Unknown = 'magenta'
}

type HTMLTab = HTMLElement & { saved?: string, select: () => void };

interface Logger { 
  (text: string, color: string): void 
};

interface Code {
  on(type:'change', handler:()=>void):void;
  setValue(t: string): void;
  getValue(): string;
  focus(): void;
  getSelectedText():string;
}

// Global UI elements
var log: Logger;
var code: Code; 
// Global comms
var mPyDevice: null | Awaited<ReturnType<typeof WebREPLDevice>>;
var ws: WebSocket;

async function WebREPLDevice(ws: WebSocket, logger:(msg:string, state: Wait)=>void, password?: string, replEvent?:(state?:Wait)=>void) {
  let replState = Wait.Unknown;
  let lineBuf = '';

  const device = {
    response: null as null | {
      expect: string[];
      result: string[];
      resolve: (r: number) => void;
      reject: (e: Error) => void;
      pr?: Promise<number>;
    },
    async waitFor(expect: string | string[], nextColor: Wait) {
      if (!Array.isArray(expect))
        expect = [expect];

      while (device.response) {
        await raiseError("Device is busy processing");
      }
      const prevColor = replState;
      replState = nextColor;
      replEvent?.(nextColor);
      try {
        const pr = new Promise<number>((resolve, reject) => device.response = { reject, resolve, expect: (expect as string[]).map(s => s.trim()), result: [] });
        device.response!.pr = pr;
        const found = await pr;
        const result = device.response!.result.join('\n');
        return { result, found };
      } finally {
        device.response = null;
        lineBuf = '';
        replState = prevColor;
        replEvent?.();
      }
    },
    untilIdle() {
      return device.response?.pr;
    },
    async send(cmd: string, endOfResult: string) {
      ws.send(cmd + "\r\n");
      await device.waitFor([cmd], Wait.Echo);
      const { result } = await device.waitFor([endOfResult], Wait.Result)
      return result;
    },
    handleStringResponse(event: MessageEvent) {
      if (typeof event.data === 'string') {
        let data = lineBuf + event.data;
        if (data.indexOf('\r\n') < 0) {
          lineBuf += event.data;
          let found;
          if (device.response && (found = device.response.expect.indexOf(lineBuf.trim()))>=0) {
            logger(lineBuf.trim(), replState);
            device.response.resolve(found);
          }
        } else {
          const lines = data.split('\r\n');
          lineBuf = '';
          for (const _line of lines) {
            const line = _line.trim();
            if (line) {
              logger(line, replState);
              if (device.response) {
                let found = device.response.expect.indexOf(line.trim());
                if (found >= 0) {
                  device.response.resolve(found);
                } else {
                  device.response.result.push(line)
                }
              }
            }
          }
        }
      }
    },
    async executeCode(value: string) {
      const lines = value.split('\n').filter(l => l);
      if (lines.length === 0)
        return "";
      while (device.response) {
        await raiseError("Device is busy processing");
      }
      if (lines.length === 1) {
        return device.send(lines[0], ">>>");
      } else {
        ws.send('\x05');
        await device.waitFor("===", Wait.Prompt);
        for (const line of lines) {
          if (line) await device.send(line, "===");
        }
        ws.send("\x04");
        return (await device.waitFor(">>>", Wait.Prompt)).result;
      }
    },
    putFile(putFileName: string, data: ArrayBuffer | Uint8Array | string, progress?: (size: number) => void) {
      let putData: Uint8Array;
      if (data instanceof Uint8Array)
        putData = data;
      else if (typeof data === 'string') {
        putData = Uint8Array.from([...data].map(s => s.charCodeAt(0)))
      } else if (data instanceof ArrayBuffer) {
        putData = new Uint8Array(data);        
      }

      return new Promise<void>((resolve, reject) => {
        let binary_state = 11;
        function handleSend(event: MessageEvent) {
          try {
            function decode_resp(data: Uint8Array) {
              if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
                const code = data[2] | (data[3] << 8);
                return code;
              } else {
                return -1;
              }
            }

            if (event.data instanceof ArrayBuffer) {
              const data = new Uint8Array(event.data);
              switch (binary_state) {
                case 11:
                  // first response for put
                  if (decode_resp(data) == 0) {
                    // send file data in chunks
                    for (let offset = 0; offset < putData.length; offset += 1024) {
                      ws.send(putData.slice(offset, offset + 1024));
                      progress?.(offset);
                    }
                    binary_state = 12;
                  }
                  break;
                case 12:
                  // final response for put
                  ws.removeEventListener('message', handleSend);
                  if (decode_resp(data) == 0) {
                    progress?.(putData.length);
                    resolve();
                  } else {
                    reject(new Error("Send failed"));
                  }
                  binary_state = 0;
                  break;
              }
            }
          } catch (ex) {
            ws.removeEventListener('message', handleSend);
            reject(ex);
          }
        }

        const dest_fsize = putData.length;
        // WEBREPL_FILE = "<2sBBQLH64s"
        const rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
        rec[0] = 'W'.charCodeAt(0);
        rec[1] = 'A'.charCodeAt(0);
        rec[2] = 1; // put
        rec[3] = 0;
        rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
        rec[12] = dest_fsize & 0xff; rec[13] = (dest_fsize >> 8) & 0xff; rec[14] = (dest_fsize >> 16) & 0xff; rec[15] = (dest_fsize >> 24) & 0xff;
        rec[16] = putFileName.length & 0xff; rec[17] = (putFileName.length >> 8) & 0xff;
        for (let i = 0; i < 64; ++i) {
          if (i < putFileName.length) {
            rec[18 + i] = putFileName.charCodeAt(i);
          } else {
            rec[18 + i] = 0;
          }
        }
        ws.addEventListener('message', handleSend);
        ws.send(rec);
      });
    },
    getFile(getFileName: string, progress?: (size: number) => void) {
      let getData = new Uint8Array(0);
      return new Promise<Uint8Array>((resolve, reject) => {
        let binary_state = 21;
        function handleReceive(event: MessageEvent) {
          try {
            function decode_resp(data: Uint8Array) {
              if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
                const code = data[2] | (data[3] << 8);
                return code;
              } else {
                return -1;
              }
            }

            if (event.data instanceof ArrayBuffer) {
              const data = new Uint8Array(event.data);
              switch (binary_state) {
                case 21:
                  // first response for get
                  if (decode_resp(data) == 0) {
                    binary_state = 22;
                    const rec = new Uint8Array(1);
                    rec[0] = 0;
                    ws.send(rec);
                  }
                  break;
                case 22: {
                  // file data
                  const sz = data[0] | (data[1] << 8);
                  if (data.length == 2 + sz) {
                    // we assume that the data comes in single chunks
                    if (sz == 0) {
                      // end of file
                      binary_state = 23;
                    } else {
                      // accumulate incoming data to get_file_data
                      const new_buf = new Uint8Array(getData.length + sz);
                      new_buf.set(getData);
                      new_buf.set(data.slice(2), getData.length);
                      getData = new_buf;
                      progress?.(getData.length);
                      const rec = new Uint8Array(1);
                      rec[0] = 0;
                      ws.send(rec);
                    }
                  } else {
                    binary_state = 0;
                  }
                  break;
                }
                case 23:
                  // final response
                  ws.removeEventListener('message', handleReceive);
                  if (decode_resp(data) == 0) {
                    progress?.(getData.length);
                    resolve(getData)
                  } else {
                    reject(new Error("Receive file failed"))
                  }
                  binary_state = 0;
                  break;
              }
            }
          } catch (ex) {
            ws.removeEventListener('message', handleReceive);
            reject(ex);
          }
        }
        // WEBREPL_FILE = "<2sBBQLH64s"
        const rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
        rec[0] = 'W'.charCodeAt(0);
        rec[1] = 'A'.charCodeAt(0);
        rec[2] = 2; // get
        rec[3] = 0;
        rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
        rec[12] = 0; rec[13] = 0; rec[14] = 0; rec[15] = 0;
        rec[16] = getFileName.length & 0xff; rec[17] = (getFileName.length >> 8) & 0xff;
        for (let i = 0; i < 64; ++i) {
          if (i < getFileName.length) {
            rec[18 + i] = getFileName.charCodeAt(i);
          } else {
            rec[18 + i] = 0;
          }
        }
        ws.addEventListener('message', handleReceive);
        ws.send(rec);
      });
    }
  };

  ws.addEventListener('message', device.handleStringResponse);
  await device.waitFor("Password:", Wait.Connect);
  ws.send(password + '\n');

  return device;
}

function connect(url: string, password: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', async function () {
      const processing = ui('processing');
      mPyDevice = await WebREPLDevice(ws, (msg,state) => log(msg,state), password, (state) => {
        processing.style.backgroundColor = state || '';
        processing.style.display =  state ? 'inline-block' : 'none';
      });
      const res = await mPyDevice.waitFor(["WebREPL connected","Access denied"], Wait.Connect);
      debugger;
      if (res.found === 1) {
        ws.close();
        alert("Incorrect password. Please try again");
        reject(res);
        return
      }
      resolve(ws);
    });
    function disconnected(e?: Event) {
      mPyDevice = null;
      console.log({ disconnect: e });
      log("Device disconnected", Wait.Connect);
      reject(new Error("Device disconnected"));
    }
    ws.addEventListener('close', disconnected);
    ws.addEventListener('error', disconnected);
  })
}

/* Internal UI functions not callable from other files */
function popup(text: string | HTMLElement = '') {
  let content: HTMLElement;
  const e = document.createElement('pre');
  e.className = 'popup';
  if (typeof text === 'string') {
    e.innerHTML = `<div class="close">\xD7</div><span>${text.replace(/[\u00A0-\u9999<>\&]/g, (i) => '&#' + i.charCodeAt(0) + ';')}</span>`;
    content = e.lastElementChild as HTMLElement;
  } else {
    e.innerHTML = `<div class="close">\xD7</div>`;
    e.append(text);
    content = text;
  }
  (e.querySelector('.close') as HTMLElement).onclick = () => {
    e.remove();
  };
  document.body.append(e);
  return {
    update(s: string) { content.textContent = s },
    close() { e.remove() }
  };
}

function raiseError(text: string): never | Promise<void> {
  if (confirm(text + "\n\nDo you want to re-connect?")) {
    ws?.close();
    mPyDevice = null;
    return startConnect();
  }
  throw new Error(text)
}

/* UI functions exported for access */
function onload() {
  const url = window.location.hash.substring(1).split("~");
  if (url[0]) {
    ui('url').value = 'ws://' + url[0];
  }
  const termElement = ui("term");
  log = (text, color) => {
    const elt = document.createElement('div');
    elt.style.color = color;
    elt.textContent = text;
    termElement.append(elt);
    termElement.scrollTop = Number.MAX_SAFE_INTEGER;
  };
  const texArea = ui("code");
  const reportPosition = () => {
    var textLines = texArea.value.substring(0, texArea.selectionStart).split("\n");
    var currentLineNumber = textLines.length;
    var currentColumnIndex = textLines[textLines.length - 1].length;
    ui('pos').textContent = `Line: ${currentLineNumber}, col: ${currentColumnIndex}`;
  };

  texArea.onkeydown = async e => {
    if (e.key === 'F1') {
      e.preventDefault();
      await getHelp();
    } else if (e.key === 'Tab') {
      let start = texArea.selectionStart;
      let end = texArea.selectionEnd;
      const startLine = texArea.value.substring(0, start).split('\n').length - 1;
      const finishLine = texArea.value.substring(0, end).split('\n').length - 1;
      if (startLine === finishLine) {
        const sub = texArea.value.substring(0,start);
        const col = sub.split('\n').pop()!.length;
        const align = col & 1 ? 3:2;
        texArea.value = sub + ' '.repeat(align) + texArea.value.substring(start);
        texArea.selectionStart = texArea.selectionEnd = start+align;
      } else {
        const lines = texArea.value.split('\n');
        for (let i = startLine; i < finishLine + 1; i++) {
          if (e.shiftKey) {
            if (lines[i].startsWith('  ')) {
              lines[i] = lines[i].substring(2);
              end -= 2;
            } else if (lines[i].startsWith(' ')) {
              lines[i] = lines[i].substring(1);
              end -= 1;
            }
          } else {
            lines[i] = '  ' + lines[i];
            end += 2;
          }
        }
        texArea.value = (lines.join(`\n`));
        texArea.selectionStart = start;
        texArea.selectionEnd = end;
      }
      e.preventDefault();
      codeChange();
    }
  };
  texArea.onkeyup = texArea.onmouseup = reportPosition;

  code = {
    getSelectedText(){
      const start = texArea.selectionStart;
      const finish = texArea.selectionEnd;
      return start == finish ? texArea.value : texArea.value.substring(start, finish);
    },
    setValue(t: string) { texArea.value = t},
    getValue() { return texArea.value },
    focus() { return texArea.focus() },
    on(type,handler) { texArea.onchange = handler }
  };

  function codeChange() {
    localStorage[ui('tabs')?.querySelector('.selected')?.id || 'code'] = code.getValue()
  }
  code.on('change',codeChange);

  lastTab = 0;
  for (const [k, v] of Object.entries(localStorage)) {
    if (k.startsWith('tab:')) {
      if (k.startsWith('tab:Unsaved'))
        lastTab += 1;
      createTab(k.slice(4), v);
    }
  }
  if (lastTab === 0) {
    lastTab = 1;
    createTab();
    code.setValue(localStorage['code'] || '');
  }

  if (window.location.protocol === 'https:') {
    const msg = document.createElement('div');
    msg.innerHTML = 'At this time, the WebREPL client cannot be accessed over HTTPS connections.<br>' +
      'Use a HTTP connection, eg. <a href="http://micropython.org/webrepl/">http://micropython.org/webrepl/</a>.<br>' +
      'Alternatively, download the files from <a href="https://github.com/micropython/webrepl">GitHub</a> and run them locally.<br>';

    popup(msg);
  }
  ui('load-file').addEventListener('click', function () {
    this.value = '';
  }, false);

  ui('load-file').addEventListener('change', function (evt) {
    const files = this.files;
    if (!files) {
      return alert("No files selected");
    }
    // Get the file info and load its data.
    const f = files[0];
    const reader = new FileReader();
    reader.onload = async function (e: Event) {
      if (!this.result)
        throw new Error("Failed to load file");
      if (ui('file-to-device').checked) {
        const dest = prompt("File name on device?",f.name);
        if (dest !== null) {
          await mPyDevice?.putFile(dest,this.result)
          createTab('\uD83C\uDC61 ' + dest, this.result.toString());
        }
      } else {
        createTab('\uD83D\uDDA5 ' + f.name, this.result.toString());
      }
    };
    reader.readAsText(f);
  }, false);
};

/* Called from the UI, so exported */
async function ControlC() {
  if (!ws || !mPyDevice) 
    return ;
  await new Promise(resolve => setTimeout(resolve, 500));
  mPyDevice.response?.reject(new Error("Interrupted"));
  mPyDevice.response = null;
  ws.send('\x03');
  mPyDevice.waitFor(">>>", Wait.Unknown);
}

async function runCode() {
  while (!mPyDevice)
    await raiseError("Device not connected");
  code.focus();
  const value = code.getSelectedText();
  const result = await mPyDevice.executeCode(value);
  return result;
}

async function startConnect() {
  if (mPyDevice) {
    mPyDevice.response?.reject(new Error("Interrupted"));
    mPyDevice.response = null;
    mPyDevice = null;
    ws.close();
  } 
  function enableConnect() {
    ui('url').disabled = false;
    ui('button').value = "Connect";
  }
  ui('url').disabled = true;
  ui('button').value = "Disconnect";
  const url = ui('url').value;
  try {
    const connection = await connect(url, ui("password").value);
    connection.addEventListener('close', enableConnect);
    window.location.hash = url.substring(5);
    await populateFileList();  
  } catch(ex){
    enableConnect();
  }
}

async function getHelp() {
  code.focus();
  const value = code.getSelectedText();
  if (value)
    popup(await mPyDevice?.executeCode(`help((${value}))`));
}

async function navigateFiles() {
  const select = ui('device-files');
  while (!mPyDevice)
    await raiseError("Not connected");

  let selected = select.value;
  if (selected[0] !== '/' && selected !== '..') {
    ui('send-file-name').value = selected.substring(1);
    return;
  }
  if (selected != '/' && selected !== '..')
    selected = selected.substring(1);
  await mPyDevice.executeCode(`import os\nos.chdir('${selected}')`);
  await populateFileList();
}
async function populateFileList() {
  const select = ui('device-files');
  while (!mPyDevice)
    await raiseError("Not connected");

  const script =
    `import os
dir = []
for i in os.listdir():
  dir.append([i,list(os.stat(i))])
[os.getcwd(),dir]`;

  const result = await mPyDevice.executeCode(script);
  let [cwd, files] = eval(result) as [string, [string, [number]][]];
  ui('cwd').textContent = cwd;
  select.innerHTML = '';
  files = files.map(file => {
    const d = file[1][0] & 0x4000;
    file[0] = (d ? '/' : '\u00A0') + file[0];
    return file;
  });
  files.sort((a, b) => a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0);
  if (cwd !== '/')
    files = [['/', [32768]], ['..', [32768]], ...files];
  for (const file of files) {
    const option = document.createElement('option');
    option.textContent = file[0];
    select.append(option);
  }
  select.selectedIndex = -1;
  return script;
}

async function deleteFile() {
  while (!mPyDevice)
    await raiseError("Not connected");
  const cwd = ui('cwd').textContent;
  let file = (cwd === '/' ? '' : cwd) + '/' + ui('send-file-name').value;
  if (file.endsWith("/"))
    file = file.substring(0,file.length-1);
  if (confirm(`Delete ${file} from device?`)) {
    await mPyDevice.executeCode(`import os\nos.unlink('${file}')\n`);
    await populateFileList();
  }
}

async function saveFileToDevice(fileName: string, putData: string | Uint8Array = code.getValue()) {
  const progress = popup('Sending ' + fileName + '...');
  try {
    await mPyDevice!.putFile(fileName, putData, (length) => progress.update('Sent ' + fileName + ', ' + length + ' bytes'));
    progress.close();
  } catch (ex) {
    progress.update(ex + ' ' + fileName);
  }
}

async function getFileFromDevice(fileName: string) {
  const progress = popup('Getting ' + fileName + '...');
  try {
    const data = await mPyDevice!.getFile(fileName, (length) => progress.update('Read ' + fileName + ', ' + length + ' bytes'));
    const cwd = ui('cwd').textContent;
    const fullName = (cwd === '/' ? '':cwd) + '/' + fileName;
    createTab('\uD83C\uDC61 ' + fullName, new TextDecoder().decode(data));
    progress.close();
  } catch (ex) {
    progress.update(ex + ' ' + fileName);
  }
}

let lastTab: number;
function createTab(name?: string, content = code.getValue()) {
  if (!name) {
    while (document.getElementById('tab:Unsaved ' + lastTab)) lastTab += 1;
    name = `Unsaved ${lastTab++}`
  }
  const existingTab = document.getElementById('tab:' + name) as HTMLTab;
  if (existingTab) {
    existingTab.saved = content;
    if (!existingTab.classList.contains('selected'))
      existingTab.select();
    return existingTab;
  }

  const tab = document.createElement('span') as HTMLTab;
  tab.id = 'tab:' + name;
  tab.innerHTML = `${name} <span class="close">&#215;</span>`;
  tab.saved = content;
  tab.onclick = tab.select = function (ev?: MouseEvent) {
    ev?.preventDefault();
    if (!this.parentElement)
      return;
    const selected = ui('tabs').querySelector('.selected') as HTMLTab;
    if (selected !== this) {
      if (selected) {
        selected.saved = code.getValue();
        selected.classList.remove('selected');
      }
      this.classList.add('selected');
      code.setValue(this.saved || '');
    }
    if (ev)
      code.focus();
  };
  (tab.querySelector('.close') as HTMLElement).onclick = function (ev) {
    ev.preventDefault();
    const next = (tab.nextElementSibling || tab.previousElementSibling) as HTMLTab;
    delete localStorage[tab.id];
    tab.remove();
    if (next?.select)
      next.select();
    else
      createTab();
  };

  ui('tabs').append(tab);
  tab.select();
  localStorage[tab.id] = code.getValue();
}

function ui(id: 'url' | 'password' | 'load-file' | 'send-file-name'): HTMLInputElement;
function ui(id: 'button' | 'put-file-button'): HTMLButtonElement;
function ui(id: 'device-files'): HTMLSelectElement;
function ui(id: 'file-to-device'): HTMLInputElement;
function ui(id: 'processing'): HTMLDivElement;
function ui(id: 'code'): HTMLTextAreaElement;
function ui(id: string): HTMLElement;
function ui(id: string): HTMLElement {
  const e = document.getElementById(id)
  if (!e) {
    throw new Error("Missing UI element: " + id)
  }
  return e;
}

Object.assign(exports,{
  onload, 
  ui,

  getFileFromDevice,
  saveFileToDevice,
  deleteFile,
  navigateFiles,

  getHelp,
  startConnect,
  runCode,
  ControlC,

  createTab
});
/*
function get_ver() {
  // WEBREPL_REQ_S = "<2sBBQLH64s"
  const rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
  rec[0] = 'W'.charCodeAt(0);
  rec[1] = 'A'.charCodeAt(0);
  rec[2] = 3; // GET_VER
  // rest of "rec" is zero

  // initiate GET_VER
  binary_state = 31;
  ws.send(rec);
}
case 31:
  // first (and last) response for GET_VER
  console.log('GET_VER', data.toString());
  binary_state = 0;
  break;
*/
})(window)

/* mPy helpers - global for eval */
function dict_keys<T = unknown>(X: T) { return X }
