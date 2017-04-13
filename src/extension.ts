'use strict';

import * as vscode from 'vscode';
import * as ts from 'typescript';
import throttle = require('lodash.throttle');

// TODO: Clean up defensive development guards (DEBUG, most try-catches, etc), as the extension seems to work without errors,
// and the vscode extension platform can mostly be trusted to do the right thing.

const DEBUG = false;

if (DEBUG) {
    process.on('unhandledRejection', (_p: Promise<any>, reason: any) => {
        console.log('UNHANDLED: %s', reason && reason.stack || reason);
    });
}

// Tracks all documents with open subdocuments
const activeDocuments = new Map<vscode.TextDocument, {
    closeActiveSubdocumentWithReason(reason: string): Promise<void>
}>();

export function activate(_context: vscode.ExtensionContext) {

    vscode.commands.registerTextEditorCommand('editor.openSubdocument', editor => {
        runCommand(editor, { withoutFilename: true });
    });
    vscode.commands.registerTextEditorCommand('editor.openSubdocument.named', editor => {
        runCommand(editor, { withoutFilename: false });
    });
    vscode.commands.registerTextEditorCommand('editor.closeSubdocuments', async _editor => {
        try {
            for (let handle of activeDocuments.values()) {
                // Alternatively could close only the document/subdocument that is open in the current editor, but let's close
                // them all for now.
                await handle.closeActiveSubdocumentWithReason('Closed via shortcut. This virtual document can be closed.');
            }
        } catch (err) {
            if (DEBUG) {
                console.log('closeSubdocuments error: %s', err && err.stack || err);
            }
        }
    });

    function runCommand(editor: vscode.TextEditor, options: { withoutFilename: boolean }) {
        try {
            const doc = editor.document;
            const cursorOffset = doc.offsetAt(editor.selection.active);
            let templateStart = 0;
            let templateEnd = 0;
            const lang = doc.languageId;
            const config = vscode.workspace.getConfiguration('templateLiteralEditor.regexes');
            if (config.has(lang) && typeof config.get(lang) === 'string') {
                const text = doc.getText();
                let matcher: RegExp;
                try {
                    matcher = new RegExp(config.get(lang) as string, 'g');
                } catch (err) {
                    console.error('INVALID REGEX for %s: %s\n%s', lang, config.get(lang), err && err.stack || err);
                    throw err;
                }
                let match: RegExpExecArray | null;
                while ((match = matcher.exec(text)) !== null) {
                    if (typeof match[1] === 'string' && typeof match[2] === 'string' && typeof match[3] === 'string') {
                        // Cursor at boundaries is ok, but only inner content is used as a template
                        if (match.index <= cursorOffset && cursorOffset <= match.index + match[0].length) {
                            templateStart = match.index + match[1].length;
                            templateEnd = match.index + match[1].length + match[2].length;
                            break;
                        }
                    }
                }
            } else if (doc.languageId === 'typescript' || doc.languageId === 'javascript') {
                // Default JS and TS to proper tokenizing instead of regexp matching
                const source = ts.createSourceFile(doc.fileName, doc.getText(), ts.ScriptTarget.Latest, true);
                // Find the outermost template literal
                let template: ts.TemplateLiteral | undefined;
                let token = (ts as any).getTokenAtPosition(source, cursorOffset);
                while (token) {
                    if (
                        token.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
                        token.kind === ts.SyntaxKind.TemplateExpression
                    ) {
                        template = token;
                    }
                    token = token.parent;
                }
                if (template) {
                    templateStart = template.getStart() + 1;
                    templateEnd = template.getEnd() - 1;
                }
            } else {
                // Omitted
            }

            if (templateStart !== 0) {
                vscode.languages.getLanguages().then(languages => {
                    // How to get proper language list, with icons etc?
                    const sorted = ['html'].concat(languages.filter(lang => lang !== 'html'));
                    vscode.window.showQuickPick(sorted, { placeHolder: 'Open in Language Mode' }).then(language => {
                        if (language) {
                            activateSubdocument(
                                language,
                                editor,
                                doc.positionAt(templateStart),
                                doc.positionAt(templateEnd),
                                options.withoutFilename,
                            ).catch(err => {
                                if (DEBUG) {
                                    console.log('ACTIVATION ERROR: %s', err && err.stack || err);
                                }
                                throw err;
                            });
                        }
                    });
                });
            } else {
                if (DEBUG) {
                    console.log('RUNCOMMAND template not found under cursor for language %s', doc.languageId);
                }
            }
        } catch (err) {
            if (DEBUG) {
                console.log('RUNCOMMAND ERROR: %s', err && err.stack || err);
            }
            throw err;
        }
    }

    async function activateSubdocument(
        language: string,
        editor: vscode.TextEditor,
        start: vscode.Position,
        end: vscode.Position,
        withoutFilename: boolean
    ) {
        const doc = editor.document;
        // Keep track of document range where template literal resides
        let templateRange = new vscode.Range(start, end);

        // Calculate cursor position relative to viewport top for subdocument scroll to match
        // const cursorPosition = editor.selection.active;
        // await vscode.commands.executeCommand('cursorMove', {
        //     to: 'viewPortTop'
        // });
        // const viewPortTopPosition = editor.selection.active;
        // // Move cursor back to where it was
        // await vscode.commands.executeCommand('cursorMove', {
        //     to: 'down',
        //     value: cursorPosition.line - viewPortTopPosition.line
        // });

        // Only one active subdocument per document allowed for simplicity.
        if (activeDocuments.has(doc)) {
            await activeDocuments.get(doc)!.closeActiveSubdocumentWithReason('Reloading.');
            if (withoutFilename) {
                // Add artificial delay, as otherwise the new document is not created for some reason.
                // Perhaps there's a race condition in VS Code and the new doc is destroyed immediately.
                await new Promise(resolve => {
                    setTimeout(() => {
                        resolve();
                    }, 100);
                });
            }
        }
        activeDocuments.set(doc, { async closeActiveSubdocumentWithReason() { } });

        // Create subdocument with chosen language/extension. "withoutFilename" version always creates a new untitled document,
        // the other version reuses the same document when languages match (and if the API works at all on Windows).
        // Reusing is a bit quicker, and won't flicker as much, but results in intertwined undo histories and
        // a larger amount of stale editors.
        // Could be made configurable depending on template tag, keybinding, etc.
        let subdoc: vscode.TextDocument;

        if (withoutFilename) {
            // This form is not in typescript definitions but is documented here
            // https://code.visualstudio.com/docs/extensionAPI/vscode-api#workspace.openTextDocument
            // It always creates a new untitled file.
            subdoc = await (vscode.workspace.openTextDocument as any)({ language }) as vscode.TextDocument;
        } else {
            // This works usually nicely, reusing the same subdocument for same source, but may give invalid document
            // on some platforms?
            const filepath = doc.fileName + '.virtual.' + language; // Needs path too? Don't want to save it...
            subdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(filepath).with({ scheme: 'untitled' }));
            // Not actually untitled as has a bogus filename, but helps keep track of tab names
            // See https://github.com/Microsoft/vscode/issues/723#issuecomment-252411918
            // _subdoc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/' + filepath));
        }

        // Open editor in side by side view
        // TODO experiment if there's access to options.selection.startLineNumber and options.selection.startColumn
        // to set initial cursor position instead of using cursorMove commands
        const subeditor = await vscode.window.showTextDocument(
            subdoc,
            editor.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One
        );

        // Keep track of change origins. Both subdocument and document changes allowed. Initial edit needs to be suppressed.
        let changeOrigin: 'activate' | 'document' | 'subdocument' | 'dispose' | null = 'activate';

        // Install document change listener before first edit
        const changeListener = vscode.workspace.onDidChangeTextDocument(change => {
            // Suppress possible late edits
            if (changeOrigin === 'dispose') {
                return;
            }
            if (change.document === subdoc) {
                // Suppress first edit.
                if (changeOrigin === 'activate') {
                    changeOrigin = null;
                    return;
                }
                if (changeOrigin === 'document') {
                    // Document sync received, mark further edits as unknown
                    changeOrigin = null;
                } else {
                    // We don't care about actual edits and partial templateRange synchronization,
                    // just copy everything in case there are changes
                    throttledSyncToDocument();
                }
            } else if (change.document === doc) {
                if (changeOrigin === 'subdocument') {
                    // Subdocument sync received, mark further edits as unknown
                    changeOrigin = null;
                } else {
                    // Track only simple changes in original document (does not touch template boundaries)
                    const isValid = change.contentChanges.every(({ range: changeRange }) => {
                        return (
                            changeRange.end.isBefore(templateRange.start) ||
                            changeRange.start.isAfter(templateRange.end) ||
                            templateRange.contains(changeRange)
                        );
                    });
                    if (!isValid) {
                        // We don't track complex edits in original document, let's close
                        // subdocument for safety. We don't want to retokenize the document and
                        // try to infer which template is which.
                        closeSubdocumentWithReason(
                            'Source document has been modified. This virtual editor can be closed.'
                        ).catch(err => {
                            if (DEBUG) {
                                console.log('onDidChangeTextDocument error: %s', err && err.stack || err);
                            }
                        });
                    } else {
                        // Defer sync until all contentChanges are processed, so that changes, content and templateRange match
                        let needsSync = false;
                        change.contentChanges.forEach(({ range: changeRange, text: changeText }) => {
                            if (changeRange.start.isAfter(templateRange.end)) {
                                // Simplest case: No templateRange update needed for changes below template
                                if (DEBUG) {
                                    // Not actually needed, but can be enabled to see problems earlier
                                    needsSync = true;
                                }
                            } else if (changeRange.end.isBefore(templateRange.start)) {
                                // General case before template, a bit complex due to depending on both changeRange and
                                // changeText line count etc
                                // TODO count with match and use doc.eol from vscode 1.11
                                const insertedLines = changeText.split(/\r\n|\r|\n/);
                                const lineDiff = insertedLines.length - (changeRange.end.line - changeRange.start.line + 1);
                                let charDiff = 0;
                                if (changeRange.end.line < templateRange.start.line) {
                                    // Simple change above template, just count lines and move the templateRange if needed
                                } else {
                                    // Change touches the template start line
                                    // first remove changeRange chars, it does not matter if there are multiple lines
                                    charDiff -= (changeRange.end.character - changeRange.start.character);
                                    // then add new changeText chars, only last line counts
                                    charDiff += insertedLines[insertedLines.length - 1].length;
                                    if (insertedLines.length > 1) {
                                        // If a line break is introduced, push to beginning of line
                                        charDiff -= changeRange.start.character;
                                    }
                                }
                                if (lineDiff || charDiff) {
                                    // Move templateRange accordingly
                                    templateRange = new vscode.Range(
                                        // Start row and col may change
                                        templateRange.start.line + lineDiff,
                                        templateRange.start.character + charDiff,
                                        // End row may change
                                        templateRange.end.line + lineDiff,
                                        // End col changes only if the templateRange is a single line
                                        templateRange.isSingleLine ?
                                            templateRange.end.character + charDiff :
                                            templateRange.end.character
                                    );
                                    if (DEBUG) {
                                        // Not actually needed, but can be enabled to see problems earlier
                                        needsSync = true;
                                    }
                                }
                            } else if (templateRange.contains(changeRange)) {
                                // General case inside template, also a bit complex due to depending on both changeRange and
                                // changeText line count etc
                                // TODO count with match and use doc.eol from vscode 1.11
                                const insertedLines = changeText.split(/\r\n|\r|\n/);
                                const lineDiff = insertedLines.length - (changeRange.end.line - changeRange.start.line + 1);
                                let charDiff = 0;
                                if (changeRange.end.line < templateRange.end.line) {
                                    // Simple change above template end, just count lines and move the templateRange end
                                    // if needed
                                } else {
                                    // Change touches the template end line
                                    // first remove changeRange chars, it does not matter if there are multiple lines
                                    charDiff -= (changeRange.end.character - changeRange.start.character);
                                    // then add new changeText chars, only last line counts
                                    charDiff += insertedLines[insertedLines.length - 1].length;
                                    if (insertedLines.length > 1) {
                                        // If a line break is introduced, the last line starts at the beginning of line
                                        charDiff -= changeRange.start.character;
                                    }
                                }
                                // Move templateRange accordingly
                                templateRange = new vscode.Range(
                                    // Start row and col stay the same
                                    templateRange.start.line,
                                    templateRange.start.character,
                                    // End row and col may change
                                    templateRange.end.line + lineDiff,
                                    templateRange.end.character + charDiff
                                );
                                needsSync = true;
                            }
                        });
                        if (needsSync) {
                            throttledSyncToSubdocument();
                        }
                    }
                }
            }
        });

        // Make first edit to the subdocument.
        // NOTE untitled docs allow setting initial content as of vscode 1.11, use that when named docs are not used anymore.
        await subeditor.edit(builder => {
            const totalRange = subdoc.validateRange(new vscode.Range(0, 0, 100000, 100000))
            builder.replace(totalRange, doc.getText(templateRange));
        }, { undoStopBefore: false, undoStopAfter: true });

        // Move cursor to proper position
        await vscode.commands.executeCommand('cursorMove', {
            to: 'down',
            value: (editor.selection.active.line - templateRange.start.line) - subeditor.selection.active.line
        });
        await vscode.commands.executeCommand('cursorMove', {
            to: 'right',
            value: Math.max(
                editor.selection.active.character - (subeditor.selection.active.line === 0 ? templateRange.start.character : 0),
                0
            ) - subeditor.selection.active.character
        });

        // // How to scroll subdocument to match document viewport, and keep them in sync?
        // await vscode.commands.executeCommand('revealLine', {
        //     lineNumber: cursorSubposition.line,
        //     at: 'top'
        // });
        // // Proper implementation would leave dead space at top, so that lines would be matched even for small documents
        // await vscode.commands.executeCommand('editorScroll', {
        //     to: 'up',
        //     by: 'line',
        //     value: cursorPosition.line - viewPortTopPosition.line,
        // });

        // Center viewport if possible, for now
        await vscode.commands.executeCommand('revealLine', {
            lineNumber: subeditor.selection.active.line,
            at: 'center'
        });

        // const statusBarItem = vscode.window.createStatusBarItem();
        // statusBarItem.text = 'Currently open template editors $(file-code): sync scroll, close all, etc';
        // statusBarItem.show();

        // const decorationType = vscode.window.createTextEditorDecorationType({
        //     isWholeLine: true,
        //     backgroundColor: '#222'
        // })

        // Experiment with cursor syncing
        // vscode.window.onDidChangeTextEditorSelection(event => {
        //     if (event.textEditor === subeditor) {
        //
        //         (async() => {
        //
        //             // Experimental line highlighter (won't be native-like)
        //             // editor.setDecorations(
        //             //     decorationType, [
        //             //         new vscode.Range(
        //             //             templateRange.start.line + subeditor.selection.active.line,
        //             //             0,
        //             //             templateRange.start.line + subeditor.selection.active.line,
        //             //             1,
        //             //         )
        //             //     ]
        //             // )
        //
        //             // Experimental cursor sync (flickers)
        //             // await vscode.window.showTextDocument(doc, editor.viewColumn, /*preserveFocus*/ false);
        //             // await vscode.commands.executeCommand('cursorMove', {
        //             //     to: 'down',
        //             //     value: (templateRange.start.line + subeditor.selection.active.line) - editor.selection.active.line
        //             // });
        //             // await vscode.commands.executeCommand('cursorMove', {
        //             //     to: 'right',
        //             //     value: (subeditor.selection.active.line === 0 ? templateRange.start.character : 0) +
        //             //         subeditor.selection.active.character - editor.selection.active.character
        //             // });
        //             // await vscode.window.showTextDocument(subdoc, subeditor.viewColumn, /*preserveFocus*/ false);
        //
        //         })().catch(err => {
        //             if (DEBUG) {
        //                 console.log('didChangeSelection error: %s', err && err.stack || err);
        //             }
        //             throw err;
        //         });
        //     }
        // })

        /**
         * Handlers
         */

        const documentCloseListener = vscode.workspace.onDidCloseTextDocument(closedDoc => {
            if (closedDoc === doc) {
                closeSubdocumentWithReason('Source document closed. This virtual document can be closed.').catch(err => {
                    if (DEBUG) {
                        console.log('documentCloseListener error: %s', err && err.stack || err);
                    }
                });
            }
        });
        const subdocumentCloseListener = vscode.workspace.onDidCloseTextDocument(closedDoc => {
            if (closedDoc === subdoc) {
                closeSubdocumentWithReason('Subdocument closed. This virtual document can be closed.').catch(err => {
                    if (DEBUG) {
                        console.log('subdocumentCloseListener error: %s', err && err.stack || err);
                    }
                });
            }
        });
        // These may prevent some sync issues, but may also annoy the user if they are unnecessary.
        // Unfortunately reloading the window won't trigger any listeners, and changing e.g. line endings are untested.
        // const configChangeListener = vscode.workspace.onDidChangeConfiguration(() => {
        //     disposeSubdocument('Workspace configuration changed. This virtual document can be closed.');
        // });
        // const optionsChangeListener = vscode.window.onDidChangeTextEditorOptions(({textEditor}) => {
        //     if (textEditor.document === doc || textEditor.document === subdoc) {
        //         disposeSubdocument('Document options changed. This virtual document can be closed.');
        //     }
        // });
        // It would be nice if saving the subdocument could be interrupted and the original would be saved instead.

        const throttledSyncToDocument = throttle(async () => {
            try {
                // We have to always take a new reference to the editor, as it may have been hidden
                // and a new editor may need to be created.
                const newEditor = await vscode.window.showTextDocument(doc, editor.viewColumn, /*preserveFocus*/ true);
                const editOk = await newEditor.edit(editBuilder => {
                    // We don't care about actual edits and partial templateRange synchronization,
                    // just copy everything in case there are changes

                    // Mark next edit as originating from subdocument. Does not consider multiple edits
                    // at the same time to both documents.
                    changeOrigin = 'subdocument';
                    editBuilder.replace(templateRange, subdoc.getText());
                    // We calculate new range based on subdoc size. Depends on both documents having the same config.
                    templateRange = new vscode.Range(
                        // Start row and col stay the same
                        templateRange.start.line,
                        templateRange.start.character,
                        // End row depends on subdoc line count
                        templateRange.start.line + subdoc.lineCount - 1,
                        // End col depends on whether there is only single line or more
                        (subdoc.lineCount === 1 ? templateRange.start.character : 0) +
                            subdoc.lineAt(subdoc.lineCount - 1).range.end.character
                    )
                });
                if (!editOk) {
                    // If there are multiple edits, they may not succeed, and then templateRange will be out of sync. Better to fail then.
                    throw new Error('Sync did not succeed');
                }
            } catch (err) {
                if (DEBUG) {
                    console.log('SYNC ERROR %s', err && err.stack || err);
                }
                closeSubdocumentWithReason(
                    'Source document could not be synced with subdocument. This virtual editor can be closed.'
                ).catch(err => {
                    if (DEBUG) {
                        console.log('throttledSyncToDocument error: %s', err && err.stack || err);
                    }
                });
            }
        }, 100);

        const throttledSyncToSubdocument = throttle(async () => {
            try {
                // We have to always take a new reference to the editor, as it may have been hidden
                // and a new editor may need to be created.
                const newSubeditor = await vscode.window.showTextDocument(
                    subdoc, subeditor.viewColumn, /*preserveFocus*/ true
                );
                const editOk = await newSubeditor.edit(editBuilder => {
                    // We don't care about actual edits and partial templateRange synchronization,
                    // just copy everything in case there are changes

                    // Mark next edit as originating from document. Does not consider multiple edits
                    // at the same time to both documents.
                    changeOrigin = 'document';
                    const totalRange = subdoc.validateRange(new vscode.Range(0, 0, 100000, 100000));
                    // We copy whole literal to subdoc. Depends on both documents having the same config.
                    editBuilder.replace(totalRange, doc.getText(templateRange));
                });
                if (!editOk) {
                    // If there are multiple edits, they may not succeed, and then templateRange will be out of sync.
                    // Better to fail then.
                    throw new Error('Sync to subdocument did not succeed');
                }
            } catch (err) {
                if (DEBUG) {
                    console.log('SUBDOC SYNC ERROR %s', err && err.stack || err);
                }
                closeSubdocumentWithReason(
                    'Subdocument could not be synced with original document. This virtual editor can be closed.'
                ).catch(err => {
                    if (DEBUG) {
                        console.log('throttledSyncToSubdocument error: %s', err && err.stack || err);
                    }
                });
            }
        }, 100);

        async function closeSubdocumentWithReason(reason: string) {
            try {
                if (DEBUG) {
                    console.log('DISPOSING: %s', reason);
                }
                changeOrigin = 'dispose';
                changeListener.dispose();

                documentCloseListener.dispose();
                subdocumentCloseListener.dispose();

                activeDocuments.delete(doc);

                if (withoutFilename) {
                    // Close untitled subdocs via action, moves focus so may pipe quick keypresses to wrong doc unfortunately
                    await closeSubeditor(vscode.window.activeTextEditor);
                } else {
                    // Mark titled documents as tainted. Note that revertAndCloseActiveEditors should work on them too.
                    await markSubdocumentAsTainted(reason);
                }
            } catch (err) {
                if (DEBUG) {
                    console.log('closeSubdocumentWithReason error: %s', err && err.stack || err);
                }
                throw err;
            }
        }

        async function markSubdocumentAsTainted(reason: string) {
            if (vscode.workspace.textDocuments.indexOf(subdoc) >= 0) {
                try {
                    let newSubeditor = await vscode.window.showTextDocument(
                        subdoc, subeditor.viewColumn, /*preserveFocus*/ true
                    );
                    let ok = await newSubeditor.edit(builder => {
                        const totalRange = subdoc.validateRange(new vscode.Range(0, 0, 100000, 100000));
                        builder.replace(totalRange, reason || 'This virtual editor can be closed.');
                    });
                    if (!ok) {
                        throw new Error('Dispose edit could not succeed');
                    }
                } catch (err) {
                    if (DEBUG) {
                        console.log('DISPOSE ERR %s', err && err.stack || err);
                    }
                }
            }
        }

        async function closeSubeditor(currentEditor?: vscode.TextEditor) {
            if (vscode.workspace.textDocuments.indexOf(subdoc) >= 0) {
                // Note: subdocument may be visible in multiple editors, but luckily reverting seems to close all of them.
                try {
                    // Move focus temporarily to subdocument. Try to minimize time for the focus to be in wrong doc as the
                    // user is typing.
                    await vscode.window.showTextDocument(subdoc, subeditor.viewColumn, /*preserveFocus*/ false);
                    // Artificial delay, to prevent "TextEditor disposed" warning (in Extension Development Host only).
                    await new Promise(resolve => {
                        setTimeout(() => {
                            resolve();
                        }, 0);
                    });
                    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                    // Move focus back to where it was, if available
                    if (currentEditor) {
                        if (currentEditor === subeditor) {
                            // Common case: closing subeditor via Ctrl+Shift+Backspace from subeditor. Focus on
                            /// original document (if available) instead of the closed editor (which would create a new editor).
                            if (vscode.workspace.textDocuments.indexOf(editor.document) >= 0) {
                                await vscode.window.showTextDocument(
                                    editor.document, editor.viewColumn, /*preserveFocus*/ false
                                );
                            }
                        } else {
                            await vscode.window.showTextDocument(
                                currentEditor.document, currentEditor.viewColumn, /*preserveFocus*/ false
                            );
                        }
                    }
                } catch (err) {
                    if (DEBUG) {
                        console.log('DISPOSE ERR %s', err && err.stack || err);
                    }
                }
            }
        }

        // We are ready, update document disposer to proper one
        activeDocuments.set(doc, { closeActiveSubdocumentWithReason: closeSubdocumentWithReason });
    }
}

// Cleanup on exit. This does not seem to help when reloading workspace? Subdocuments cannot be cleared on exit?
// To be able to close stale editors, must save state on each template open, and check state at plugin activation
// (and activate earlier, when js/ts loaded)?
export async function deactivate(_context: vscode.ExtensionContext) {
    try {
        for (let handle of activeDocuments.values()) {
            await handle.closeActiveSubdocumentWithReason('Extension deactivated. This virtual document can be closed.');
        }
    } catch (err) {
        if (DEBUG) {
            console.log('DEACTIVATE error: %s', err && err.stack || err);
        }
    }
}
