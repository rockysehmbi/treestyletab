/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2011-2017
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

// workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
var gTabIdWrongToCorrect = {};
var gTabIdCorrectToWrong = {};

function startObserveApiTabs() {
  browser.tabs.onActivated.addListener(onApiTabActivated);
  browser.tabs.onUpdated.addListener(onApiTabUpdated);
  browser.tabs.onCreated.addListener(onApiTabCreated);
  browser.tabs.onRemoved.addListener(onApiTabRemoved);
  browser.tabs.onMoved.addListener(onApiTabMoved);
  browser.tabs.onAttached.addListener(onApiTabAttached);
  browser.tabs.onDetached.addListener(onApiTabDetached);
}

function endObserveApiTabs() {
  browser.tabs.onActivated.removeListener(onApiTabActivated);
  browser.tabs.onUpdated.removeListener(onApiTabUpdated);
  browser.tabs.onCreated.removeListener(onApiTabCreated);
  browser.tabs.onRemoved.removeListener(onApiTabRemoved);
  browser.tabs.onMoved.removeListener(onApiTabMoved);
  browser.tabs.onAttached.removeListener(onApiTabAttached);
  browser.tabs.onDetached.removeListener(onApiTabDetached);
}


var gCreatingTabs = {};

function hasCreatingTab() {
  return Object.keys(gCreatingTabs).length > 0;
}

function waitUntilAllTabsAreaCreated() {
  return waitUntilTabsAreaCreated(Object.keys(gCreatingTabs).map(aId => parseInt(aId)));
}

function waitUntilTabsAreaCreated(aIdOrIds) {
  if (!Array.isArray(aIdOrIds))
    aIdOrIds = [aIdOrIds];
  var creatingTabs = aIdOrIds.filter(aId => !!aId)
    .map(aId => typeof aId == 'string' ? parseInt(aId.match(/^tab-\d+-(\d+)$/)[1]) : aId)
    .map(aId => gCreatingTabs[aId])
    .filter(aCreating => !!aCreating);
  if (creatingTabs.length)
    return Promise.all(creatingTabs);
}


async function onApiTabActivated(aActiveInfo) {
  if (gTargetWindow && aActiveInfo.windowId != gTargetWindow)
    return;

  var container = getOrBuildTabsContainer(aActiveInfo.windowId);

  var byInternalOperation = parseInt(container.dataset.internalFocusCount) > 0;
  if (byInternalOperation)
    decrementContainerCounter(container, 'internalFocusCount');
  var silently = parseInt(container.dataset.internalSilentlyFocusCount) > 0;
  if (silently)
    decrementContainerCounter(container, 'internalSilentlyFocusCount');
  var byTabDuplication = parseInt(container.dataset.duplicatingTabsCount) > 0;

  await waitUntilTabsAreaCreated(aActiveInfo.tabId);

  var newTab = getTabById({ tab: aActiveInfo.tabId, window: aActiveInfo.windowId });
  if (!newTab)
    return;

  log('tabs.onActivated: ', dumpTab(newTab));
  updateTabFocused(newTab);

  var byCurrentTabRemove = !!container.resolveClosedWhileActiveForPreviousActiveTab;
  if (byCurrentTabRemove) {
    incrementContainerCounter(container, 'tryingReforcusForClosingCurrentTabCount');
    container.resolveClosedWhileActiveForPreviousActiveTab();
    delete container.resolveClosedWhileActiveForPreviousActiveTab;
    let focusRedirected = await container.focusRedirectedForClosingCurrentTab;
    delete container.focusRedirectedForClosingCurrentTab;
    if (parseInt(container.dataset.tryingReforcusForClosingCurrentTabCount) > 0) // reduce count even if not redirected
      decrementContainerCounter(container, 'tryingReforcusForClosingCurrentTabCount');
    log('focusRedirected: ', focusRedirected);
    if (focusRedirected)
      return;
  }
  else if (parseInt(container.dataset.tryingReforcusForClosingCurrentTabCount) > 0) { // treat as "redirected unintentional tab focus"
    decrementContainerCounter(container, 'tryingReforcusForClosingCurrentTabCount');
    byCurrentTabRemove  = true;
    byInternalOperation = false;
  }

  if (!ensureLivingTab(newTab)) // it can be removed while waiting
    return;

  var focusOverridden = window.onTabFocusing && await onTabFocusing(newTab, {
    byCurrentTabRemove,
    byTabDuplication,
    byInternalOperation,
    silently
  });
  if (focusOverridden)
    return;

  if (!ensureLivingTab(newTab)) // it can be removed while waiting
    return;

  window.onTabFocused && await onTabFocused(newTab, {
    byCurrentTabRemove,
    byTabDuplication,
    byInternalOperation,
    silently
  });
}

function clearOldActiveStateInWindow(aWindowId) {
  var container = getTabsContainer(aWindowId);
  if (!container)
    return [];
  var oldTabs = container.querySelectorAll(`.${kTAB_STATE_ACTIVE}`);
  for (let oldTab of oldTabs) {
    oldTab.classList.remove(kTAB_STATE_ACTIVE);
    if (oldTab.apiTab) // this function can be applied for cached tab.
      oldTab.apiTab.active = false;
  }
}

async function onApiTabUpdated(aTabId, aChangeInfo, aTab) {
  if (gTargetWindow && aTab.windowId != gTargetWindow)
    return;

  // workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
  var correctId = gTabIdWrongToCorrect[aTabId];
  if (correctId)
    aTabId = aTab.id = correctId;

  await waitUntilTabsAreaCreated(aTabId);

  var updatedTab = getTabById({ tab: aTabId, window: aTab.windowId });
  if (!updatedTab)
    return;

  if (configs.logOnUpdated)
    log('tabs.onUpdated ', aTabId, aChangeInfo, aTab, updatedTab.apiTab);

  //updatedTab.apiTab = aTab;
  /*
    Updated openerTabId is not notified via tabs.onUpdated due to
    https://bugzilla.mozilla.org/show_bug.cgi?id=1409262 , so it can be
    notified with delay as a part of the complete tabs.Tab object,
    "aTab" given to this handler. To prevent unexpected tree brekage,
    we should apply updated openerTabId only when it is modified at
    outside of TST (in other words, by any other addon.)
  */
  for (let key of Object.keys(aChangeInfo)) {
    updatedTab.apiTab[key] = aChangeInfo[key];
  }
  if (configs.enableWorkaroundForBug1409262 &&
      aTab.openerTabId != updatedTab.apiTab.TSTUpdatedOpenerTabId) {
    if (configs.logOnUpdated)
      log(`openerTabId of ${aTabId} is changed by someone!: ${updatedTab.apiTab.TSTUpdatedOpenerTabId} => ${aTab.openerTabId}`);
    updatedTab.apiTab.TSTUpdatedOpenerTabId = updatedTab.apiTab.openerTabId = aTab.openerTabId;
  }

  updateTab(updatedTab, aChangeInfo, {
    tab: aTab
  });
  updateParentTab(getParentTab(updatedTab));

  window.onTabUpdated && onTabUpdated(updatedTab, aChangeInfo);
}

function onApiTabCreated(aTab) {
  if (gTargetWindow && aTab.windowId != gTargetWindow)
    return;

  log('tabs.onCreated: ', aTab.id);
  return onNewTabTracked(aTab);
}

async function onNewTabTracked(aTab) {
  if (gTargetWindow && aTab.windowId != gTargetWindow)
    return null;

  log('onNewTabTracked: ', aTab);
  var container = getOrBuildTabsContainer(aTab.windowId);
  var newTab = buildTab(aTab, { inRemote: !!gTargetWindow });
  newTab.classList.add(kTAB_STATE_OPENING);
  // append to DOM tree to detect duplication
  container.appendChild(newTab);

  gCreatingTabs[aTab.id] = newTab.uniqueId;
  var uniqueId = await newTab.uniqueId;
  if (gCreatingTabs[aTab.id] === newTab.uniqueId)
    delete gCreatingTabs[aTab.id];

  // move to correct position after tabs.onRemoved is processed
  var nextTab = getAllTabs(container)[aTab.index];
  container.insertBefore(newTab, nextTab);

  updateTab(newTab, aTab, {
    tab:        aTab,
    forceApply: true
  });

  // tabs can be removed and detached while waiting, so cache them here for `detectTabActionFromNewPosition()`.
  var treeForActionDetection = snapshotTreeForActionDetection(newTab);

  var activeTab            = getCurrentTab(container);
  var openedWithPosition   = parseInt(container.dataset.toBeOpenedTabsWithPositions) > 0;
  var duplicatedInternally = parseInt(container.dataset.duplicatingTabsCount) > 0;

  var duplicated = duplicatedInternally || uniqueId.duplicated;
  var restored   = uniqueId.restored;
  if (restored) {
    container.restoredCount = container.restoredCount || 0;
    container.restoredCount++;
    let start = Date.now();
    if (!container.allTabsRestored) {
      log('Maybe starting to restore window ', aTab.id);
      container.allTabsRestored = new Promise((aResolve, aReject) => {
        var start = Date.now();
        var lastCount = container.restoredCount;
        var timer = setInterval(() => {
          if (lastCount != container.restoredCount) {
            lastCount = container.restoredCount;
            return;
          }
          clearTimeout(timer);
          container.allTabsRestored = null;
          container.restoredCount   = 0;
          log('All tabs are restored');
          aResolve(lastCount);
        }, 200);
      });
      let restoredWindowHandled = window.onWindowRestoring && onWindowRestoring(aTab.windowId);
      if (restoredWindowHandled)
        container.allTabsRestored = restoredWindowHandled;
    }
    window.onTabRestoring && onTabRestoring(newTab);
    await container.allTabsRestored;
    log('onNewTabTracked: continued for restored tab ', aTab.id);
  }
  if (!container.parentNode ||
      !newTab.parentNode) {
    log(' => aborted ', aTab.id);
    return;
  }

  var moved = window.onTabOpening && await onTabOpening(newTab, {
    maybeOpenedWithPosition: openedWithPosition,
    maybeOrphan: parseInt(container.dataset.toBeOpenedOrphanTabs) > 0,
    restored,
    duplicated,
    duplicatedInternally,
    activeTab
  });

  if (container.parentNode) { // it can be removed while waiting
    if (parseInt(container.dataset.toBeOpenedTabsWithPositions) > 0)
      decrementContainerCounter(container, 'toBeOpenedTabsWithPositions');

    if (parseInt(container.dataset.toBeOpenedOrphanTabs) > 0)
      decrementContainerCounter(container, 'toBeOpenedOrphanTabs');

    if (duplicatedInternally)
      decrementContainerCounter(container, 'duplicatingTabsCount');

    incrementContainerCounter(container, 'openingCount');
    setTimeout(() => {
      if (!container.parentNode) // it can be removed while waiting
        return;
      decrementContainerCounter(container, 'openingCount');
    }, 0);
  }

  if (!ensureLivingTab(newTab)) // it can be removed while waiting
    return null;

  log('uniqueId: ', uniqueId);

  window.onTabOpened && onTabOpened(newTab, {
    openedWithPosition: openedWithPosition || moved,
    restored,
    duplicated,
    duplicatedInternally,
    originalTab: duplicated && getTabById({ tab: uniqueId.originalTabId }),
    treeForActionDetection
  });
  wait(configs.newTabAnimationDuration).then(() => {
    newTab.classList.remove(kTAB_STATE_OPENING);
  });
  newTab._resolveOpened();

  if (!duplicated &&
      restored) {
    newTab.classList.add(kTAB_STATE_RESTORED);
    window.onTabRestored && onTabRestored(newTab);
    checkRecycledTab(container);
  }

  return newTab;
}

// "Recycled tab" is an existing but reused tab for session restoration.
const kBASE_RECYCLED_TAB_CONDITION = `li:not(.${kTAB_STATE_RESTORED}):not(.${kTAB_STATE_OPENING})`;
function checkRecycledTab(aContainer) {
  var possibleRecycledTabs = aContainer.querySelectorAll(`
    ${kBASE_RECYCLED_TAB_CONDITION}:not([${kCURRENT_URI}]),
    ${kBASE_RECYCLED_TAB_CONDITION}[${kCURRENT_URI}="${configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl}"],
    ${kBASE_RECYCLED_TAB_CONDITION}[${kCURRENT_URI}="about:blank"],
    ${kBASE_RECYCLED_TAB_CONDITION}[${kCURRENT_URI}="about:privatebrowsing"]
  `);
  if (possibleRecycledTabs.length == 0)
    return;

  log(`Detecting recycled tabs for session restoration from ${possibleRecycledTabs.length} tabs`);
  for (let tab of possibleRecycledTabs) {
    let currentId = tab.getAttribute(kPERSISTENT_ID);
    updateUniqueId(tab).then(aUniqueId => {
      if (!ensureLivingTab(tab) ||
          !aUniqueId.restored ||
          aUniqueId.id == currentId ||
          tab.classList.contains(kTAB_STATE_RESTORED))
        return;
      log('A recycled tab is detected: ', dumpTab(tab));
      tab.classList.add(kTAB_STATE_RESTORED);
      window.onTabRestored && onTabRestored(tab);
    });
  }
}

async function onApiTabRemoved(aTabId, aRemoveInfo) {
  log('tabs.onRemoved: ', aTabId, aRemoveInfo);
  if (gTargetWindow && aRemoveInfo.windowId != gTargetWindow)
    return;

  // workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
  var wrongId = gTabIdCorrectToWrong[aTabId];
  if (wrongId)
    delete gTabIdWrongToCorrect[wrongId];
  delete gTabIdCorrectToWrong[aTabId];

  var container = getOrBuildTabsContainer(aRemoveInfo.windowId);
  var byInternalOperation = parseInt(container.dataset.internalClosingCount) > 0;
  if (byInternalOperation)
    decrementContainerCounter(container, 'internalClosingCount');

  var oldTab = getTabById({ tab: aTabId, window: aRemoveInfo.windowId });
  if (!oldTab)
    return;

  log('tabs.onRemoved, tab is found: ', dumpTab(oldTab));

  window.onTabStateChanged && onTabStateChanged(oldTab);

  if (isActive(oldTab))
    container.resolveClosedWhileActiveForPreviousActiveTab = oldTab._resolveClosedWhileActive;

  window.onTabClosed && await onTabClosed(oldTab, {
    byInternalOperation
  });

  oldTab[kTAB_STATE_REMOVING] = true;
  oldTab.classList.add(kTAB_STATE_REMOVING);

  if (!isCollapsed(oldTab) &&
      window.onTabCompletelyClosed) {
    await onTabCompletelyClosed(oldTab, {
      byInternalOperation
    });
    onApiTabRemovedComplete(oldTab);
  }
  else {
    onApiTabRemovedComplete(oldTab);
  }
}
function onApiTabRemovedComplete(aTab) {
  clearTabRelationsForRemovedTab(aTab);
  var container = aTab.parentNode;
  if (!container) // it was removed while waiting
    return;
  container.removeChild(aTab);
  if (!container.hasChildNodes())
    container.parentNode.removeChild(container);
}
function clearTabRelationsForRemovedTab(aTab) {
  if (aTab.parentTab) {
    aTab.parentTab.childTabs = aTab.parentTab.childTabs.filter(aChild => aChild != aTab);
    aTab.parentTab = null;
  }
  for (let child of aTab.childTabs) {
    if (child.parentTab == aTab)
      child.parentTab = null;
  }
}

async function onApiTabMoved(aTabId, aMoveInfo) {
  if (gTargetWindow && aMoveInfo.windowId != gTargetWindow)
    return;

  var container = getOrBuildTabsContainer(aMoveInfo.windowId);
  var byInternalOperation = parseInt(container.dataset.internalMovingCount) > 0;

  await waitUntilTabsAreaCreated(aTabId);

  /* When a tab is pinned, tabs.onMoved may be notified before
     tabs.onUpdated(pinned=true) is notified. As the result,
     descendant tabs are unexpectedly moved to the top of the
     tab bar to follow their parent pinning tab. To avoid this
     problem, we have to wait for a while with this "async" and
     do following processes after the tab is completely pinned. */
  var movedTab = getTabById({ tab: aTabId, window: aMoveInfo.windowId });
  if (!movedTab) {
    if (byInternalOperation)
      decrementContainerCounter(container, 'internalMovingCount');
    return;
  }

  var oldPreviousTab = getPreviousTab(movedTab);
  var oldNextTab     = getNextTab(movedTab);
  if (getTabIndex(aMoveInfo) != aMoveInfo.toIndex) { // already moved
    let tabs = getAllTabs(container);
    oldPreviousTab = tabs[aMoveInfo.toIndex < aMoveInfo.fromIndex ? aMoveInfo.fromIndex : aMoveInfo.fromIndex - 1];
    oldNextTab     = tabs[aMoveInfo.toIndex < aMoveInfo.fromIndex ? aMoveInfo.fromIndex + 1 : aMoveInfo.fromIndex];
  }
  var moveInfo = clone(aMoveInfo, {
    byInternalOperation,
    oldPreviousTab,
    oldNextTab
  });
  log('tabs.onMoved: ', dumpTab(movedTab), moveInfo, movedTab.apiTab);

  var alreadyMoved = false;
  if (parseInt(container.dataset.alreadyMovedTabsCount) > 0) {
    decrementContainerCounter(container, 'alreadyMovedTabsCount');
    alreadyMoved = true;
  }

  var canceled = window.onTabMoving && await onTabMoving(movedTab, moveInfo);
  if (!canceled &&
      ensureLivingTab(movedTab)) { // it is removed while waiting
    let newNextIndex = aMoveInfo.toIndex;
    if (aMoveInfo.fromIndex < newNextIndex)
      newNextIndex++;
    let tabs    = getTabs(movedTab);
    let nextTab = tabs[newNextIndex];
    if (!alreadyMoved && movedTab.nextSibling != nextTab) {
      container.insertBefore(movedTab, nextTab);
      log('Tab nodes rearranged by tabs.onMoved listener:\n'+(!configs.debug ? '' :
        Array.slice(container.childNodes)
          .map(aTab => aTab.id+(aTab == movedTab ? '[MOVED]' : ''))
          .join('\n')
          .replace(/^/gm, ' - ')));
    }
    let startIndex = Math.min(aMoveInfo.fromIndex, aMoveInfo.toIndex);
    let endIndex   = Math.max(aMoveInfo.fromIndex, aMoveInfo.toIndex);
    for (let i = startIndex; i < endIndex; i++) {
      tabs[i].apiTab.index = i;
    }
    window.onTabMoved && await onTabMoved(movedTab, moveInfo);
  }
  if (byInternalOperation)
    decrementContainerCounter(container, 'internalMovingCount');
}

var gTreeInfoForTabsMovingAcrossWindows = {};

async function onApiTabAttached(aTabId, aAttachInfo) {
  if (gTargetWindow &&
      aAttachInfo.newWindowId != gTargetWindow)
    return;

  log('tabs.onAttached, id: ', aTabId, aAttachInfo);
  var apiTab;
  try {
    apiTab = await browser.tabs.get(aTabId).catch(handleMissingTabError);
    log(`New apiTab for attached tab ${aTabId}: `, apiTab);
    if (!apiTab)
      return;
  }
  catch(e) {
    handleMissingTabError(e);
  }

  // workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1398272
  if (apiTab.id != aTabId) {
    let oldWrongId = gTabIdCorrectToWrong[aTabId];
    if (oldWrongId)
      delete gTabIdWrongToCorrect[oldWrongId];
    gTabIdWrongToCorrect[apiTab.id] = aTabId;
    gTabIdCorrectToWrong[aTabId] = apiTab.id;
    browser.runtime.sendMessage({
      type:         kCOMMAND_BROADCAST_TAB_ID_TABLES_UPDATE,
      oldWrongId:   oldWrongId,
      newWrongId:   apiTab.id,
      newCorrectId: aTabId
    });
    apiTab.id = aTabId;
  }

  await waitUntilTabsAreaCreated(aTabId);

  clearOldActiveStateInWindow(aAttachInfo.newWindowId);
  var info = gTreeInfoForTabsMovingAcrossWindows[aTabId];
  delete gTreeInfoForTabsMovingAcrossWindows[aTabId];

  var newTab = await onNewTabTracked(apiTab);
  var byInternalOperation = newTab && parseInt(newTab.parentNode.dataset.toBeAttachedTabs) > 0;
  if (byInternalOperation)
    decrementContainerCounter(newTab.parentNode, 'toBeAttachedTabs');
  info.byInternalOperation = info.byInternalOperation || byInternalOperation;

  if (!byInternalOperation) // we should process only tabs attached by others.
    window.onTabAttachedToWindow && onTabAttachedToWindow(newTab, info);
}

function onApiTabDetached(aTabId, aDetachInfo) {
  if (gTargetWindow &&
      aDetachInfo.oldWindowId != gTargetWindow)
    return;

  log('tabs.onDetached, id: ', aTabId, aDetachInfo);
  var oldTab = getTabById({ tab: aTabId, window: aDetachInfo.oldWindowId });
  if (!oldTab)
    return;

  var byInternalOperation = parseInt(oldTab.parentNode.dataset.toBeDetachedTabs) > 0;
  if (byInternalOperation)
    decrementContainerCounter(oldTab.parentNode, 'toBeDetachedTabs');

  var info = gTreeInfoForTabsMovingAcrossWindows[aTabId] = {
    byInternalOperation,
    windowId:    aDetachInfo.oldWindowId,
    descendants: getDescendantTabs(oldTab)
  };

  window.onTabStateChanged && onTabStateChanged(oldTab);

  if (!byInternalOperation) // we should process only tabs detached by others.
    window.onTabDetachedFromWindow && onTabDetachedFromWindow(oldTab, info);

  var container = oldTab.parentNode;
  clearTabRelationsForRemovedTab(oldTab);
  container.removeChild(oldTab);
  if (!container.hasChildNodes())
    container.parentNode.removeChild(container);
}

