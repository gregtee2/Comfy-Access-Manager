/**
 * Comfy Asset Manager - Copyright (c) 2026 Greg Tee. All Rights Reserved.
 * Comfy Asset Manager — Native macOS App Launcher
 *
 * This is a lightweight Cocoa wrapper that:
 *   - Lives in /Applications like a proper Mac app
 *   - Shows in the Dock with a real icon
 *   - Starts the Node.js server on launch
 *   - Opens the browser when the server is ready
 *   - Cleans up the server on Cmd+Q / Quit
 *   - Clicking Dock icon re-opens the browser
 *   - Menu bar with Open in Browser, Quit
 */

#import <Cocoa/Cocoa.h>

// ═══════════════════════════════════════════
//  APP DELEGATE
// ═══════════════════════════════════════════

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (strong) NSTask *serverTask;
@property (strong) NSWindow *statusWindow;
@property (strong) NSTextField *statusLabel;
@property (strong) NSProgressIndicator *spinner;
@property (assign) BOOL serverStartedByUs;
@property (assign) int serverPort;
@end

@implementation AppDelegate

// ─── Launch ───
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.serverPort = 7700;
    NSString *home = NSHomeDirectory();
    NSString *appDir = [home stringByAppendingPathComponent:@"Comfy-Asset-Manager"];
    NSString *serverJS = [appDir stringByAppendingPathComponent:@"src/server.js"];

    // ── Verify the app is installed ──
    if (![[NSFileManager defaultManager] fileExistsAtPath:serverJS]) {
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Comfy Asset Manager Not Installed"];
        [alert setInformativeText:[NSString stringWithFormat:
            @"The app files were not found at:\n%@\n\nPlease run the installer first:\n"
            @"Open Terminal and paste:\n"
            @"curl -sL https://raw.githubusercontent.com/gregtee2/Digital-Media-Vault/main/scripts/mac-install.sh | bash",
            appDir]];
        [alert addButtonWithTitle:@"OK"];
        [alert setAlertStyle:NSAlertStyleCritical];
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }

    // ── Check if server is already running ──
    NSURL *checkURL = [NSURL URLWithString:
        [NSString stringWithFormat:@"http://localhost:%d/api/settings/status", self.serverPort]];
    NSData *checkData = [NSData dataWithContentsOfURL:checkURL];
    if (checkData) {
        // Server is already running — just open browser
        [self openBrowserURL];
        self.serverStartedByUs = NO;
        return;
    }

    // ── Show "Starting..." window ──
    [self showStatusWindow];

    // ── Find Node.js ──
    NSString *nodePath = [self findNode];
    if (!nodePath) {
        [self.statusWindow close];
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Node.js Not Found"];
        [alert setInformativeText:
            @"Node.js is required to run Comfy Asset Manager.\n\n"
            @"Install it with Homebrew:\n"
            @"  brew install node\n\n"
            @"Or re-run the installer which will set it up automatically."];
        [alert addButtonWithTitle:@"OK"];
        [alert setAlertStyle:NSAlertStyleCritical];
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }

    // ── Ensure log directory ──
    NSString *logDir = [appDir stringByAppendingPathComponent:@"logs"];
    [[NSFileManager defaultManager] createDirectoryAtPath:logDir
                              withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *logPath = [logDir stringByAppendingPathComponent:@"app.log"];

    // ── Start the Node.js server ──
    self.serverTask = [[NSTask alloc] init];
    [self.serverTask setExecutableURL:[NSURL fileURLWithPath:nodePath]];
    [self.serverTask setArguments:@[serverJS]];
    [self.serverTask setCurrentDirectoryURL:[NSURL fileURLWithPath:appDir]];

    // Redirect output to log file
    if (![[NSFileManager defaultManager] fileExistsAtPath:logPath]) {
        [[NSFileManager defaultManager] createFileAtPath:logPath contents:nil attributes:nil];
    }
    NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:logPath];
    [logHandle seekToEndOfFile];
    [self.serverTask setStandardOutput:logHandle];
    [self.serverTask setStandardError:logHandle];

    // Set environment with proper PATH
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSString *extraPath = [NSString stringWithFormat:@"%@:%@",
        [nodePath stringByDeletingLastPathComponent],
        env[@"PATH"] ?: @"/usr/bin:/bin"];
    env[@"PATH"] = extraPath;
    [self.serverTask setEnvironment:env];

    NSError *launchError = nil;
    [self.serverTask launchAndReturnError:&launchError];
    if (launchError) {
        [self.statusWindow close];
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Failed to Start Server"];
        [alert setInformativeText:[launchError localizedDescription]];
        [alert addButtonWithTitle:@"OK"];
        [alert runModal];
        [NSApp terminate:nil];
        return;
    }

    self.serverStartedByUs = YES;

    // ── Poll for server ready in background ──
    __weak AppDelegate *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        BOOL ready = NO;
        for (int i = 0; i < 30; i++) {
            [NSThread sleepForTimeInterval:0.5];

            // Animate status text
            dispatch_async(dispatch_get_main_queue(), ^{
                AppDelegate *s = weakSelf;
                if (!s) return;
                int dots = (i % 3) + 1;
                NSString *dotsStr = [@"..." substringToIndex:dots];
                [s.statusLabel setStringValue:
                    [NSString stringWithFormat:@"Starting server%@", dotsStr]];
            });

            // Check if server is responding
            NSURL *url = [NSURL URLWithString:
                [NSString stringWithFormat:@"http://localhost:%d", weakSelf.serverPort]];
            NSData *data = [NSData dataWithContentsOfURL:url];
            if (data) {
                ready = YES;
                dispatch_async(dispatch_get_main_queue(), ^{
                    AppDelegate *s = weakSelf;
                    if (!s) return;
                    [s.statusWindow close];
                    [s openBrowserURL];
                });
                break;
            }
        }

        if (!ready) {
            dispatch_async(dispatch_get_main_queue(), ^{
                AppDelegate *s = weakSelf;
                if (!s) return;
                [s.statusLabel setStringValue:@"⚠️ Server failed to start"];
                [s.spinner stopAnimation:nil];
                [s.spinner setHidden:YES];

                // Show log path for debugging
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC),
                    dispatch_get_main_queue(), ^{
                    [s.statusWindow close];
                    NSAlert *alert = [[NSAlert alloc] init];
                    [alert setMessageText:@"Server Failed to Start"];
                    [alert setInformativeText:[NSString stringWithFormat:
                        @"The server didn't respond within 15 seconds.\n\n"
                        @"Check the log at:\n%@/logs/app.log",
                        NSHomeDirectory()]];
                    [alert addButtonWithTitle:@"OK"];
                    [alert runModal];
                });
            });
        }
    });

    // Watch for server crashes
    self.serverTask.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            AppDelegate *s = weakSelf;
            if (s && s.serverStartedByUs) {
                s.serverStartedByUs = NO;
                // Only alert if unexpected termination
                if (task.terminationReason == NSTaskTerminationReasonUncaughtSignal) {
                    NSAlert *alert = [[NSAlert alloc] init];
                    [alert setMessageText:@"Server Crashed"];
                    [alert setInformativeText:@"The server process terminated unexpectedly.\nCheck logs/app.log for details."];
                    [alert addButtonWithTitle:@"Quit"];
                    [alert addButtonWithTitle:@"Restart"];
                    NSModalResponse resp = [alert runModal];
                    if (resp == NSAlertSecondButtonReturn) {
                        // Restart by re-launching
                        NSNotification *fakeNotif = [NSNotification notificationWithName:@"restart" object:nil];
                        [s applicationDidFinishLaunching:fakeNotif];
                    } else {
                        [NSApp terminate:nil];
                    }
                }
            }
        });
    };
}

// ─── Find Node.js binary ───
- (NSString *)findNode {
    NSArray *paths = @[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node",
        @"/opt/local/bin/node",
    ];

    for (NSString *p in paths) {
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:p]) {
            return p;
        }
    }

    // Check nvm
    NSString *nvmDir = [NSHomeDirectory() stringByAppendingPathComponent:@".nvm/versions/node"];
    NSArray *versions = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:nvmDir error:nil];
    if (versions.count > 0) {
        // Sort versions and pick the latest
        NSArray *sorted = [versions sortedArrayUsingComparator:^(NSString *a, NSString *b) {
            return [a compare:b options:NSNumericSearch];
        }];
        NSString *latest = [sorted lastObject];
        NSString *nvmNode = [[[nvmDir stringByAppendingPathComponent:latest]
            stringByAppendingPathComponent:@"bin"]
            stringByAppendingPathComponent:@"node"];
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:nvmNode]) {
            return nvmNode;
        }
    }

    // Check fnm
    NSString *fnmDir = [NSHomeDirectory() stringByAppendingPathComponent:@".fnm/node-versions"];
    versions = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:fnmDir error:nil];
    if (versions.count > 0) {
        NSArray *sorted = [versions sortedArrayUsingComparator:^(NSString *a, NSString *b) {
            return [a compare:b options:NSNumericSearch];
        }];
        NSString *latest = [sorted lastObject];
        NSString *fnmNode = [[[fnmDir stringByAppendingPathComponent:latest]
            stringByAppendingPathComponent:@"installation/bin"]
            stringByAppendingPathComponent:@"node"];
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:fnmNode]) {
            return fnmNode;
        }
    }

    return nil;
}

// ─── Status Window ───
- (void)showStatusWindow {
    self.statusWindow = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 360, 90)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered
        defer:NO];
    [self.statusWindow setTitle:@""];
    [self.statusWindow setTitlebarAppearsTransparent:YES];
    [self.statusWindow center];
    [self.statusWindow setLevel:NSFloatingWindowLevel];
    [self.statusWindow setMovableByWindowBackground:YES];

    NSView *content = [self.statusWindow contentView];

    // Spinner
    self.spinner = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(24, 30, 24, 24)];
    [self.spinner setStyle:NSProgressIndicatorStyleSpinning];
    [self.spinner setControlSize:NSControlSizeSmall];
    [self.spinner startAnimation:nil];
    [content addSubview:self.spinner];

    // Label
    self.statusLabel = [[NSTextField alloc] initWithFrame:NSMakeRect(58, 28, 280, 30)];
    [self.statusLabel setStringValue:@"Starting server..."];
    [self.statusLabel setBezeled:NO];
    [self.statusLabel setEditable:NO];
    [self.statusLabel setSelectable:NO];
    [self.statusLabel setFont:[NSFont systemFontOfSize:14 weight:NSFontWeightMedium]];
    [self.statusLabel setBackgroundColor:[NSColor clearColor]];
    [content addSubview:self.statusLabel];

    [self.statusWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

// ─── Open browser ───
- (void)openBrowserURL {
    NSURL *url = [NSURL URLWithString:
        [NSString stringWithFormat:@"http://localhost:%d", self.serverPort]];
    [[NSWorkspace sharedWorkspace] openURL:url];
}

// ─── Menu action: Open in Browser ───
- (void)openBrowser:(id)sender {
    [self openBrowserURL];
}

// ─── Clicking Dock icon opens browser ───
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    [self openBrowserURL];
    return NO;
}

// ─── Quit: stop the server ───
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (self.serverStartedByUs && self.serverTask && [self.serverTask isRunning]) {
        // Send SIGTERM for graceful shutdown
        [self.serverTask terminate];

        // Give it 3 seconds, then force kill
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC),
            dispatch_get_main_queue(), ^{
            if ([self.serverTask isRunning]) {
                [self.serverTask interrupt];
            }
        });
    }
    return NSTerminateNow;
}

// ─── Don't quit when window closes ───
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return NO;
}

@end

// ═══════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

        AppDelegate *delegate = [[AppDelegate alloc] init];
        [app setDelegate:delegate];

        // ── Menu Bar ──
        NSMenu *menuBar = [[NSMenu alloc] init];

        // App menu
        NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
        [menuBar addItem:appMenuItem];
        NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Comfy Asset Manager"];
        [appMenu addItemWithTitle:@"About Comfy Asset Manager"
                action:@selector(orderFrontStandardAboutPanel:)
                keyEquivalent:@""];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItemWithTitle:@"Open in Browser"
                action:@selector(openBrowser:) keyEquivalent:@"o"];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItemWithTitle:@"Hide Comfy Asset Manager"
                action:@selector(hide:) keyEquivalent:@"h"];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItemWithTitle:@"Quit Comfy Asset Manager"
                action:@selector(terminate:) keyEquivalent:@"q"];
        [appMenuItem setSubmenu:appMenu];

        // Window menu (standard)
        NSMenuItem *windowMenuItem = [[NSMenuItem alloc] init];
        [menuBar addItem:windowMenuItem];
        NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
        [windowMenu addItemWithTitle:@"Minimize"
                action:@selector(performMiniaturize:) keyEquivalent:@"m"];
        [windowMenuItem setSubmenu:windowMenu];

        // Help menu
        NSMenuItem *helpMenuItem = [[NSMenuItem alloc] init];
        [menuBar addItem:helpMenuItem];
        NSMenu *helpMenu = [[NSMenu alloc] initWithTitle:@"Help"];
        [helpMenu addItemWithTitle:@"Open in Browser"
                action:@selector(openBrowser:) keyEquivalent:@""];
        [helpMenuItem setSubmenu:helpMenu];

        [app setMainMenu:menuBar];
        [app run];
    }
    return 0;
}
