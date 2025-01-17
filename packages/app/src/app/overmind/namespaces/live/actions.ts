import {
  LiveMessage,
  LiveMessageEvent,
  UserViewRange,
  UserSelection,
} from '@codesandbox/common/lib/types';
import { Action, AsyncAction, Operator } from 'app/overmind';
import { withLoadApp } from 'app/overmind/factories';
import getItems from 'app/overmind/utils/items';
import { filter, fork, pipe } from 'overmind';

import * as internalActions from './internalActions';
import * as liveMessage from './liveMessageOperators';
import { IModuleStateModule } from './types';

export const internal = internalActions;

export const signInToRoom: AsyncAction<{
  roomId: string;
}> = withLoadApp(async ({ state, effects, actions }, { roomId }) => {
  await actions.internal.signIn({});

  if (state.isLoggedIn) {
    await actions.live.roomJoined({
      roomId,
    });
  }
});

export const onOperationError: Action<{
  moduleShortid: string;
  moduleInfo: IModuleStateModule;
}> = ({ actions }, { moduleShortid, moduleInfo }) => {
  actions.live.internal.initializeModuleFromState({
    moduleShortid,
    moduleInfo,
  });
};

export const roomJoined: AsyncAction<{
  roomId: string;
}> = withLoadApp(async ({ state, effects, actions }, { roomId }) => {
  if (!state.isLoggedIn) {
    return;
  }

  await effects.vscode.initialized;
  await effects.vscode.closeAllTabs();

  state.live.joinSource = 'live';

  if (state.live.isLive) {
    actions.live.internal.disconnect();
  }

  const sandbox = await actions.live.internal.initialize(roomId);

  if (!sandbox) {
    return;
  }

  if (state.updateStatus === 'available') {
    const modal = 'liveVersionMismatch';
    effects.analytics.track('Open Modal', { modal });
    state.currentModal = modal;
  }

  await actions.internal.setCurrentSandbox(sandbox);

  actions.editor.listenToSandboxChanges({ sandboxId: sandbox.id });
  const items = getItems(state);
  const defaultItem = items.find(i => i.defaultOpen) || items[0];

  state.workspace.openedWorkspaceItem = defaultItem.id;

  await effects.vscode.changeSandbox(sandbox, fs => {
    state.editor.modulesByPath = fs;
  });

  effects.live.sendModuleStateSyncRequest();
  effects.vscode.openModule(state.editor.currentModule);
  state.editor.isLoading = false;
});

export const createLiveClicked: AsyncAction<string> = async (
  { actions, effects, state },
  sandboxId
) => {
  effects.analytics.track('Create Live Session');

  const roomId = await effects.api.createLiveRoom(sandboxId);
  const sandbox = await actions.live.internal.initialize(roomId);
  const currentSandbox = state.editor.currentSandbox;

  if (!sandbox || !currentSandbox) {
    effects.notificationToast.error('Unable to create live room');
    return;
  }

  Object.assign(sandbox, {
    modules: sandbox.modules.map(module => {
      const currentModule = currentSandbox.modules.find(
        currentSandboxModule => currentSandboxModule.shortid === module.shortid
      );
      return {
        ...module,
        code: currentModule ? currentModule.code : '',
      };
    }),
  });
  state.editor.modulesByPath = effects.vscode.sandboxFsSync.create(sandbox);

  effects.live.sendModuleStateSyncRequest();
};

export const liveMessageReceived: Operator<LiveMessage, any> = pipe(
  filter((_, payload) =>
    Object.values(LiveMessageEvent).includes(payload.event)
  ),
  filter(({ state }) => Boolean(state.live.isLive && state.live.roomInfo)),
  fork((_, payload) => payload.event, {
    [LiveMessageEvent.JOIN]: liveMessage.onJoin,
    [LiveMessageEvent.MODULE_STATE]: liveMessage.onModuleState,
    [LiveMessageEvent.USER_ENTERED]: liveMessage.onUserEntered,
    [LiveMessageEvent.USERS_CHANGED]: liveMessage.onUsersChanged,
    [LiveMessageEvent.USER_LEFT]: liveMessage.onUserLeft,
    [LiveMessageEvent.EXTERNAL_RESOURCES]: liveMessage.onExternalResources,
    [LiveMessageEvent.MODULE_SAVED]: liveMessage.onModuleSaved,
    [LiveMessageEvent.MODULE_CREATED]: liveMessage.onModuleCreated,
    [LiveMessageEvent.MODULE_MASS_CREATED]: liveMessage.onModuleMassCreated,
    [LiveMessageEvent.MODULE_UPDATED]: liveMessage.onModuleUpdated,
    [LiveMessageEvent.MODULE_DELETED]: liveMessage.onModuleDeleted,
    [LiveMessageEvent.DIRECTORY_CREATED]: liveMessage.onDirectoryCreated,
    [LiveMessageEvent.DIRECTORY_UPDATED]: liveMessage.onDirectoryUpdated,
    [LiveMessageEvent.DIRECTORY_DELETED]: liveMessage.onDirectoryDeleted,
    [LiveMessageEvent.USER_SELECTION]: liveMessage.onUserSelection,
    [LiveMessageEvent.USER_CURRENT_MODULE]: liveMessage.onUserCurrentModule,
    [LiveMessageEvent.USER_VIEW_RANGE]: liveMessage.onUserViewRange,
    [LiveMessageEvent.LIVE_MODE]: liveMessage.onLiveMode,
    [LiveMessageEvent.LIVE_CHAT_ENABLED]: liveMessage.onLiveChatEnabled,
    [LiveMessageEvent.LIVE_ADD_EDITOR]: liveMessage.onLiveAddEditor,
    [LiveMessageEvent.LIVE_REMOVE_EDITOR]: liveMessage.onLiveRemoveEditor,
    [LiveMessageEvent.OPERATION]: liveMessage.onOperation,
    [LiveMessageEvent.CONNECTION_LOSS]: liveMessage.onConnectionLoss,
    [LiveMessageEvent.DISCONNECT]: liveMessage.onDisconnect,
    [LiveMessageEvent.OWNER_LEFT]: liveMessage.onOwnerLeft,
    [LiveMessageEvent.CHAT]: liveMessage.onChat,
    [LiveMessageEvent.NOTIFICATION]: liveMessage.onNotification,
  })
);

export const applyTransformation: AsyncAction<{
  operation: any;
  moduleShortid: string;
}> = async ({ effects }, { operation, moduleShortid }) => {
  try {
    await effects.vscode.applyOperation(moduleShortid, operation);
  } catch (error) {
    // Do not care about the error, but something went wrong and we
    // need a full sync
    effects.live.sendModuleStateSyncRequest();
  }
};

export const sendCurrentSelection: Action = ({ state, effects }) => {
  if (!state.live.roomInfo) {
    return;
  }

  const { liveUserId } = state.live;
  if (liveUserId && state.live.currentSelection) {
    effects.live.sendUserSelection(
      state.editor.currentModuleShortid,
      liveUserId,
      state.live.currentSelection
    );
  }
};

export const sendCurrentViewRange: Action = ({ state, effects }) => {
  if (!state.live.roomInfo) {
    return;
  }

  if (!state.live.isCurrentEditor) {
    return;
  }

  const { liveUserId, currentViewRange } = state.live;
  if (liveUserId && currentViewRange) {
    effects.live.sendUserViewRange(
      state.editor.currentModuleShortid,
      liveUserId,
      currentViewRange
    );
  }
};

export const onViewRangeChanged: Action<UserViewRange> = (
  { state, effects },
  viewRange
) => {
  if (!state.live.roomInfo) {
    return;
  }

  if (state.live.isCurrentEditor) {
    const { liveUserId } = state.live;
    const moduleShortid = state.editor.currentModuleShortid;
    if (!liveUserId) {
      return;
    }

    state.live.currentViewRange = viewRange;
    const userIndex = state.live.roomInfo.users.findIndex(
      u => u.id === liveUserId
    );

    if (userIndex !== -1) {
      if (state.live.roomInfo.users[userIndex]) {
        state.live.roomInfo.users[
          userIndex
        ].currentModuleShortid = moduleShortid;

        state.live.roomInfo.users[userIndex].viewRange = viewRange;

        effects.live.sendUserViewRange(moduleShortid, liveUserId, viewRange);
      }
    }
  }
};

export const onSelectionChanged: Action<UserSelection> = (
  { state, effects },
  selection
) => {
  if (!state.live.roomInfo) {
    return;
  }

  const { liveUserId } = state.live;
  const moduleShortid = state.editor.currentModuleShortid;
  if (!moduleShortid || !liveUserId) {
    return;
  }

  state.live.currentSelection = selection;
  const userIndex = state.live.roomInfo.users.findIndex(
    u => u.id === liveUserId
  );

  if (userIndex > -1) {
    const user = state.live.roomInfo.users[userIndex];
    if (user) {
      user.currentModuleShortid = moduleShortid;
      user.selection = selection;

      effects.live.sendUserSelection(moduleShortid, liveUserId, selection);
    }
  }
};

export const onModeChanged: Action<{ mode: string }> = (
  { state, effects },
  { mode }
) => {
  if (state.live.isOwner && state.live.roomInfo) {
    state.live.roomInfo.mode = mode;
    effects.live.sendLiveMode(mode);
  }
};

export const onAddEditorClicked: Action<{
  liveUserId: string;
}> = ({ state, effects }, { liveUserId }) => {
  if (!state.live.roomInfo) {
    return;
  }
  state.live.roomInfo.editorIds.push(liveUserId);

  effects.live.sendEditorAdded(liveUserId);
};

export const onRemoveEditorClicked: Action<any> = (
  { state, effects },
  { liveUserId, data }
) => {
  const userId = liveUserId || data.editor_user_id;

  if (!state.live.roomInfo) {
    return;
  }

  const editors = state.live.roomInfo.editorIds;
  const newEditors = editors.filter(id => id !== userId);

  state.live.roomInfo.editorIds = newEditors;

  effects.live.sendEditorRemoved(liveUserId);
};

export const onSessionCloseClicked: Action = ({ actions, effects }) => {
  effects.live.sendClosed();
  actions.live.internal.disconnect();
};

export const onNavigateAway: Action = ({ actions, state }) => {
  if (state.live.isLive) {
    actions.live.internal.disconnect();
  }
};

export const onToggleNotificationsHidden: Action = ({ state }) => {
  state.live.notificationsHidden = !state.live.notificationsHidden;
};

export const onSendChat: Action<{ message: string }> = (
  { effects },
  { message }
) => {
  effects.live.sendChat(message);
};

export const onChatEnabledToggle: Action = ({ effects, state }) => {
  effects.analytics.track('Enable Live Chat');

  if (state.live.isOwner && state.live.roomInfo) {
    const chatEnabled = state.live.roomInfo.chatEnabled;
    state.live.roomInfo.chatEnabled = !chatEnabled;
    effects.live.sendChatEnabled(!chatEnabled);
  }
};

export const onFollow: Action<{
  liveUserId: string;
}> = ({ state, effects, actions }, { liveUserId }) => {
  if (!state.live.roomInfo) {
    return;
  }

  effects.analytics.track('Follow Along in Live');
  state.live.followingUserId = liveUserId;
  actions.live.revealViewRange({ liveUserId });

  if (state.editor.currentModule) {
    // In case the selections were hidden first
    actions.editor.internal.updateSelectionsOfModule({
      module: state.editor.currentModule,
    });
  }
};

export const onUserLeft: Action<{
  liveUserId: string;
}> = ({ state, actions }, { liveUserId }) => {
  if (!state.live.roomInfo) {
    return;
  }

  if (state.live.followingUserId && state.live.followingUserId === liveUserId) {
    // Unfollow user if they are the one who left
    actions.live.onStopFollow();
  }

  actions.live.internal.clearUserSelections(liveUserId);
};

export const onStopFollow: Action = ({ state, effects, actions }) => {
  if (!state.live.roomInfo) {
    return;
  }

  state.live.followingUserId = null;

  if (state.editor.currentModule) {
    // In case the selections were hidden first
    actions.editor.internal.updateSelectionsOfModule({
      module: state.editor.currentModule,
    });
  }
};

export const revealViewRange: Action<{ liveUserId: string }> = (
  { state, effects, actions },
  { liveUserId }
) => {
  if (!state.live.roomInfo) {
    return;
  }

  const user = state.live.roomInfo.users.find(u => u.id === liveUserId);

  if (user && user.currentModuleShortid && state.editor.currentSandbox) {
    const { modules } = state.editor.currentSandbox;
    const module = modules.filter(
      ({ shortid }) => shortid === user.currentModuleShortid
    )[0];

    actions.editor.moduleSelected({ id: module.id });

    if (user.viewRange) {
      effects.vscode.revealRange(user.viewRange);
    }
  }
};

export const revealCursorPosition: AsyncAction<{ liveUserId: string }> = async (
  { state, effects, actions },
  { liveUserId }
) => {
  if (!state.live.roomInfo) {
    return;
  }

  const user = state.live.roomInfo.users.find(u => u.id === liveUserId);

  if (user && user.currentModuleShortid && state.editor.currentSandbox) {
    const { modules } = state.editor.currentSandbox;
    const module = modules.filter(
      ({ shortid }) => shortid === user.currentModuleShortid
    )[0];

    await actions.editor.moduleSelected({ id: module.id });

    if (user.selection?.primary?.cursorPosition) {
      effects.vscode.revealPositionInCenterIfOutsideViewport(
        user.selection.primary.cursorPosition,
        0
      );
    }
  }
};
