(function () {
        var parsedUrl = new URL(window.location.href);
        if (parsedUrl.searchParams.get("token")) {
          parsedUrl.searchParams.delete("token");
          window.history.replaceState({}, "", parsedUrl.href);
        }

        var bridgeToken = parsedUrl.searchParams.get("nf_editor_token") || window.location.pathname.split("/").filter(Boolean)[0];
        var documentRoute = window.location.pathname.match(/\/doc\/(?:workspaces\/[^/]+\/)?tree\/(.*)$/);
        var notebookPath = decodeURIComponent(documentRoute ? documentRoute[1] : "notebook.ipynb");
        var jupyterApp;
        var focusedShell;
        var applyingFocusedLayout = false;
        var focusedLayoutTimeout;
        var fitFrame;
        var fitTimeouts = [];
        var serializedContexts = new WeakSet();

        function serializeSaves(context) {
          if (!context || serializedContexts.has(context)) return;
          serializedContexts.add(context);
          var save = context.save.bind(context);
          var tail = Promise.resolve();
          // Native autosave, toolbar saves, and parent saves share this context.
          // Finish the disk write AND metadata refresh before the next save starts.
          context.save = function () {
            var pending = tail.then(function () { return save(); });
            tail = pending.catch(function () {});
            return pending;
          };
        }

        function notebookWidget(app) {
          if (!app || !app.shell) return null;
          var current = app.shell.currentWidget;
          function matches(widget) {
            return widget && !widget.isDisposed && widget.context && widget.context.path === notebookPath;
          }
          if (matches(current)) return current;
          if (typeof app.shell.widgets === "function") {
            return Array.from(app.shell.widgets("main")).find(matches) || null;
          }
          return null;
        }

        function waitForNotebookContext() {
          var app = window.jupyterapp;
          var widget = notebookWidget(app);
          if (!widget || !widget.context) {
            window.setTimeout(waitForNotebookContext, 50);
            return;
          }
          serializeSaves(widget.context);
          app.shell.currentChanged.connect(function () {
            var current = app.shell.currentWidget;
            if (current) serializeSaves(current.context);
          });
        }

        function fitJupyterLayout() {
          if (!jupyterApp || !jupyterApp.shell) return;
          jupyterApp.shell.fit();
          jupyterApp.shell.update();
        }

        function scheduleJupyterFit() {
          window.cancelAnimationFrame(fitFrame);
          fitTimeouts.forEach(function (timeout) {
            window.clearTimeout(timeout);
          });
          fitTimeouts = [];
          fitFrame = window.requestAnimationFrame(function () {
            fitFrame = window.requestAnimationFrame(fitJupyterLayout);
          });
          [100, 250, 500].forEach(function (delay) {
            fitTimeouts.push(window.setTimeout(fitJupyterLayout, delay));
          });
        }

        function scheduleFocusedLayout() {
          window.clearTimeout(focusedLayoutTimeout);
          focusedLayoutTimeout = window.setTimeout(configureFocusedLayout, 0);
        }

        function handleLayoutModified() {
          if (!applyingFocusedLayout) scheduleFocusedLayout();
        }

        function configureFocusedLayout() {
          var app = window.jupyterapp;
          if (!app || !app.shell) return false;

          var shell = app.shell;
          if (focusedShell !== shell) {
            if (focusedShell) {
              focusedShell.layoutModified.disconnect(handleLayoutModified);
            }
            shell.layoutModified.connect(handleLayoutModified);
            focusedShell = shell;
          }

          applyingFocusedLayout = true;
          try {
            if (!shell.leftCollapsed) shell.collapseLeft();
            if (!shell.rightCollapsed) shell.collapseRight();
            if (
              typeof shell.collapseDown === "function" &&
              !shell.downCollapsed
            ) {
              shell.collapseDown();
            }
            if (shell.isSideTabBarVisible("left")) {
              shell.toggleSideTabBarVisibility("left");
            }
            if (shell.isSideTabBarVisible("right")) {
              shell.toggleSideTabBarVisibility("right");
            }
            if (
              shell.mode === "single-document" &&
              shell.isTopInSimpleModeVisible()
            ) {
              shell.toggleTopInSimpleModeVisibility();
            }
            var menuWidget = Array.from(shell.widgets("menu"))[0];
            var menuPanel = menuWidget && menuWidget.parent;
            if (
              menuPanel &&
              menuPanel.id === "jp-menu-panel" &&
              !menuPanel.isHidden
            ) {
              menuPanel.hide();
            }
          } finally {
            applyingFocusedLayout = false;
          }

          shell.node.dataset.vercelFocusedEditor = "true";
          jupyterApp = app;
          scheduleJupyterFit();
          return true;
        }

        function waitForJupyterApp() {
          var app = window.jupyterapp;
          if (!app) {
            window.setTimeout(waitForJupyterApp, 50);
            return;
          }
          Promise.resolve(app.restored).catch(function () {}).then(function () {
            if (!configureFocusedLayout()) {
              window.setTimeout(waitForJupyterApp, 50);
              return;
            }
            [50, 100, 250, 500, 1000, 2000].forEach(function (delay) {
              window.setTimeout(configureFocusedLayout, delay);
            });
          });
        }

        window.addEventListener("resize", scheduleJupyterFit);
        if (window.visualViewport) {
          window.visualViewport.addEventListener("resize", scheduleJupyterFit);
        }
        new ResizeObserver(scheduleJupyterFit).observe(document.documentElement);
        waitForJupyterApp();
        waitForNotebookContext();

        var toolQueue = Promise.resolve();
        function snapshot(widget) {
          return widget.content.model.sharedModel.cells.map(function (cell) {
            var value = cell.toJSON();
            return { id: cell.getId(), cell_type: value.cell_type, source: cell.getSource(),
              outputs: (value.outputs || []).slice(-10).map(function (output) {
                return { text: String(output.text || (output.data && output.data["text/plain"]) || "").slice(-8000),
                  error: output.evalue, traceback: (output.traceback || []).slice(-10).map(function (line) { return line.slice(-2000); }),
                  has_image: !!(output.data && output.data["image/png"]) };
              }) };
          });
        }
        async function notebookTool(data) {
          if (!["scroll_notebook", "read_notebook", "insert_cell", "replace_cell", "run_cell"].includes(data.tool))
            throw new Error("Unsupported notebook tool. Reconnect the editor to update it.");
          var app = window.jupyterapp;
          var widget = notebookWidget(app);
          if (!widget || !widget.content || !widget.context || widget.context.path !== notebookPath)
            throw new Error("Open the current notebook and wait for Jupyter to load.");
          await widget.context.ready;
          var model = widget.content.model.sharedModel;
          var args = data.args || {};
          if (data.tool === "scroll_notebook") {
            var notebook = widget.content;
            var scroller = notebook.outerNode;
            if (!scroller) throw new Error("Notebook scrolling is not ready.");
            var direction = args.direction;
            if (direction === "up" || direction === "down") {
              scroller.scrollBy({ top: (direction === "up" ? -1 : 1) * scroller.clientHeight * 0.8, behavior: "instant" });
            } else if (["top", "bottom", "cell"].includes(direction)) {
              var target = direction === "top" ? 0 : direction === "bottom" ? model.cells.length - 1 :
                model.cells.findIndex(function (c) { return c.getId() === args.cell_id; });
              if (target < 0 || target >= model.cells.length) throw new Error("Cell not found. Read the notebook again.");
              var alignment = direction === "top" ? "start" : direction === "bottom" ? "end" : (args.alignment || "start");
              if (!["start", "center", "end"].includes(alignment)) throw new Error("Invalid scroll alignment.");
              await notebook.scrollToItem(target, alignment);
            } else throw new Error("Invalid scroll direction.");
            return { scrolled: true, direction: direction, scroll_top: scroller.scrollTop, viewport_height: scroller.clientHeight };
          }
          if (data.tool === "read_notebook") {
            var cells = snapshot(widget);
            if (JSON.stringify(cells).length > 150000) throw new Error("Notebook is too large for chat (150 KB text limit).");
            return { cells: cells };
          }
          if (typeof args.source === "string" && args.source.length > 50000) throw new Error("Cell is too large.");
          if (data.tool === "insert_cell") {
            if (!["code", "markdown"].includes(args.cell_type) || typeof args.source !== "string") throw new Error("Invalid cell.");
            var after = args.after_id === "" ? -1 : model.cells.findIndex(function (c) { return c.getId() === args.after_id; });
            if (args.after_id !== "" && after < 0) return { error: "Insertion target no longer exists. Read the notebook again and choose a current cell ID.", code: "cell_missing" };
            var id = crypto.randomUUID();
            model.insertCell(after + 1, { id: id, cell_type: args.cell_type, source: args.source, metadata: {},
              ...(args.cell_type === "code" ? { outputs: [], execution_count: null } : {}) });
            return { cell_id: id, inserted: true };
          }
          var index = model.cells.findIndex(function (c) { return c.getId() === args.cell_id; });
          if (index < 0) return { error: "Cell no longer exists. Read the notebook again and choose a current cell ID.", code: "cell_missing" };
          var cell = model.cells[index];
          if (cell.getSource() !== args.expected_source) return {
            error: "Cell source changed. Review current_cell and revise the operation using its source as expected_source. Do not retry the old arguments.",
            code: "source_conflict", current_cell: { id: cell.getId(), source: cell.getSource().slice(0, 50000), truncated: cell.getSource().length > 50000 }
          };
          if (data.tool === "replace_cell") {
            if (typeof args.source !== "string") throw new Error("Invalid source.");
            cell.setSource(args.source);
            return { cell_id: cell.getId(), updated: true };
          }
          if (data.tool === "run_cell") {
            if (cell.cell_type !== "code") throw new Error("Only code cells can run.");
            app.shell.activateById(widget.id);
            widget.content.deselectAll();
            widget.content.activeCellIndex = index;
            await app.commands.execute("notebook:run-cell", { toolbar: true });
            return { cell: snapshot(widget).find(function (c) { return c.id === args.cell_id; }) };
          }
          throw new Error("Unknown notebook tool.");
        }
        window.addEventListener("message", function (event) {
          var data = event.data;
          if (event.source !== window.parent || __PARENT_ORIGINS__.indexOf(event.origin) === -1 ||
              !data || data.type !== "vercel-notebook-capabilities" || data.token !== bridgeToken || typeof data.id !== "string") return;
          var widget = notebookWidget(window.jupyterapp);
          var kernel = widget && widget.sessionContext && widget.sessionContext.session && widget.sessionContext.session.kernel;
          event.source.postMessage({ type: "vercel-notebook-tool-result", id: data.id, result: {
            protocol: 2, ready: !!widget, kernel_started: !!kernel, connected: !!kernel && kernel.connectionStatus === "connected"
          } }, event.origin);
        });
        window.addEventListener("message", function (event) {
          var data = event.data;
          if (event.source !== window.parent || __PARENT_ORIGINS__.indexOf(event.origin) === -1 ||
              !data || data.type !== "vercel-notebook-tool" || data.token !== bridgeToken || typeof data.id !== "string") return;
          var pending = toolQueue.then(function () { return notebookTool(data); });
          toolQueue = pending.catch(function () {});
          pending.then(function (result) {
            event.source.postMessage({ type: "vercel-notebook-tool-result", id: data.id, result: result }, event.origin);
          }, function (error) {
            event.source.postMessage({ type: "vercel-notebook-tool-result", id: data.id, error: error.message }, event.origin);
          });
        });

        // Export the browser model without contacting the server or waiting on a save dialog.
        window.addEventListener("message", function (event) {
          var data = event.data;
          if (event.source !== window.parent || __PARENT_ORIGINS__.indexOf(event.origin) === -1 ||
              !data || data.type !== "vercel-notebook-export" || data.token !== bridgeToken || typeof data.id !== "string") return;
          try {
            var widget = notebookWidget(window.jupyterapp);
            if (!widget || !widget.context.model) throw new Error("The notebook is not loaded. Keep this tab open and retry.");
            var source = JSON.stringify(widget.context.model.toJSON());
            event.source.postMessage({ type: "vercel-notebook-saved", id: data.id, source: source }, event.origin);
          } catch (error) {
            event.source.postMessage({ type: "vercel-notebook-save-error", id: data.id, message: error.message }, event.origin);
          }
        });

        window.addEventListener("message", async function (event) {
          var data = event.data;
          if (
            event.source !== window.parent ||
            __PARENT_ORIGINS__.indexOf(event.origin) === -1 ||
            !data ||
            data.type !== "vercel-notebook-save" ||
            data.token !== bridgeToken ||
            typeof data.id !== "string"
          ) return;

          try {
            var app = window.jupyterapp;
            var widget = notebookWidget(app);
            if (!widget || !widget.context || widget.context.path !== notebookPath) {
              throw new Error("The notebook is not open yet. Wait for Jupyter to load and retry.");
            }
            await widget.context.ready;
            serializeSaves(widget.context);
            await widget.context.save();
            event.source.postMessage({ type: "vercel-notebook-saved", id: data.id }, event.origin);
          } catch (error) {
            event.source.postMessage({
              type: "vercel-notebook-save-error",
              id: data.id,
              message: error instanceof Error ? error.message : "Jupyter could not save the notebook."
            }, event.origin);
          }
        });
      })();
