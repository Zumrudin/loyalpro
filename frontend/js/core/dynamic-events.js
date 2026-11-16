// Fixed application callbacks. HTML carries only action IDs and JSON data; never executable code.
UIEvents.register({
"agent-settings-1": function (event, args) {
  removeAgentNumber(args[0]);
},
"broadcast-rules-1": function (event, args) {
  nrToggle(args[0]);
},
"broadcast-rules-2": function (event, args) {
  nrShowLog(args[0]);
},
"broadcast-rules-3": function (event, args) {
  nrOpenEditor(args[0]);
},
"broadcast-rules-4": function (event, args) {
  nrDelete(args[0]);
},
"broadcast-rules-5": function (event, args) {
  nrCondType(args[0], this.value);
},
"broadcast-rules-6": function (event, args) {
  nrRemoveCond(args[0]);
},
"broadcast-rules-7": function (event, args) {
  nrCondFilter(args[0], this.value);
},
"broadcast-rules-8": function (event, args) {
  nrCondToggleId(args[0], args[1], this.checked);
},
"broadcast-rules-9": function (event, args) {
  nrToggleChannel(args[0]);
},
"broadcasts-monitor-1": function (event, args) {
  bcMonRetryDraft();
},
"broadcasts-monitor-2": function (event, args) {
  bcMonPage(-1);
},
"broadcasts-monitor-3": function (event, args) {
  bcMonPage(1);
},
"broadcasts-1": function (event, args) {
  bcToggleSeg(args[0], this);
},
"broadcasts-2": function (event, args) {
  bcOpenMonitor(args[0]);
},
"broadcasts-3": function (event, args) {
  event.stopPropagation();
  bcCancel(args[0]);
},
"care-1": function (event, args) {
  careToggleProgram(args[0]);
},
"care-2": function (event, args) {
  careOpenPreview(args[0]);
},
"care-3": function (event, args) {
  careOpenProgramModal(args[0]);
},
"care-4": function (event, args) {
  careDeleteProgram(args[0]);
},
"care-5": function (event, args) {
  careTouchField(args[0], 'title', this.value);
},
"care-6": function (event, args) {
  careTouchField(args[0], 'delayDays', this.value);
},
"care-7": function (event, args) {
  careTouchField(args[0], 'sendTime', this.value);
},
"care-8": function (event, args) {
  careMoveTouch(args[0], -1);
},
"care-9": function (event, args) {
  careMoveTouch(args[0], 1);
},
"care-10": function (event, args) {
  careRemoveTouch(args[0]);
},
"care-11": function (event, args) {
  careTouchMode(args[0], 'free');
},
"care-12": function (event, args) {
  careTouchMode(args[0], 'strict');
},
"care-13": function (event, args) {
  careTouchField(args[0], 'intentText', this.value);
},
"care-14": function (event, args) {
  careToggleEnr(args[0]);
},
"care-15": function (event, args) {
  event.stopPropagation();
  careStopEnr(args[0]);
},
"care-16": function (event, args) {
  event.stopPropagation();
  careOpenChat(args[0]);
},
"cert-requests-1": function (event, args) {
  crNewCert();
},
"cert-requests-2": function (event, args) {
  crOpenInGenerator(args[0]);
},
"cert-requests-3": function (event, args) {
  crSetStatus(args[0], 'done');
},
"cert-requests-4": function (event, args) {
  crSetStatus(args[0], 'rejected');
},
"chat-composer-1": function (event, args) {
  _cmpClearFile();
},
"clients-1": function (event, args) {
  openCD(args[0]);
},
"clients-2": function (event, args) {
  event.stopPropagation();
  openCD(args[0]);
},
"clients-3": function (event, args) {
  doSyncCard(args[0]);
},
"clients-4": function (event, args) {
  doSyncCard(args[0]);
},
"clients-5": function (event, args) {
  quickB(args[0], 1);
},
"clients-6": function (event, args) {
  quickB(args[0], -1);
},
"clients-7": function (event, args) {
  cdOpenPurchase(args[0]);
},
"conditions-editor-1": function (event, args) {
  condType(args[0], args[1], this.value);
},
"conditions-editor-2": function (event, args) {
  condRemove(args[0], args[1]);
},
"conditions-editor-3": function (event, args) {
  condFilter(args[0], args[1], this.value);
},
"conditions-editor-4": function (event, args) {
  condToggleId(args[0], args[1], args[2], this.checked);
},
"dashboard-verdicts-1": function (event, args) {
  vdCloseList();
},
"dashboard-verdicts-2": function (event, args) {
  vdOpenRow(this);
},
"dashboard-verdicts-3": function (event, args) {
  vdCloseDialog();
},
"dashboard-verdicts-4": function (event, args) {
  vdCloseDialog();
},
"economics-1": function (event, args) {
  ecoSortBy(args[0]);
},
"economics-2": function (event, args) {
  ecoOpenService(args[0]);
},
"economics-3": function (event, args) {
  document.getElementById('ecoDetail').innerHTML = '';
},
"economics-4": function (event, args) {
  if (event.key === 'Enter') ecoLoadGoods();
},
"economics-5": function (event, args) {
  ecoLoadGoods();
},
"economics-6": function (event, args) {
  ecoSavePrice(args[0], this);
},
"economics-7": function (event, args) {
  ecoShowReceipts(args[0], this);
},
"economics-8": function (event, args) {
  ecoLinkCard(args[0], args[1]);
},
"economics-9": function (event, args) {
  if (this.value) ecoLinkCard(args[0], this.value);
},
"economics-10": function (event, args) {
  ecoLookupCard(args[0], this);
},
"economics-11": function (event, args) {
  ecoUnlinkCard(args[0], args[1]);
},
"economics-12": function (event, args) {
  ecoDeleteManual(args[0]);
},
"economics-13": function (event, args) {
  ecoSyncCards();
},
"economics-14": function (event, args) {
  ecoNewManual();
},
"economics-15": function (event, args) {
  ecoManAddItem();
},
"economics-16": function (event, args) {
  ecoSaveManual();
},
"economics-17": function (event, args) {
  document.getElementById('ecoManualForm').innerHTML = '';
},
"economics-18": function (event, args) {
  ecoManPickGood(this);
},
"economics-19": function (event, args) {
  ecoEditScheme(args[0]);
},
"economics-20": function (event, args) {
  ecoDeleteScheme(args[0]);
},
"economics-21": function (event, args) {
  ecoEditAssignment(args[0]);
},
"economics-22": function (event, args) {
  ecoDeleteAssignment(args[0]);
},
"economics-23": function (event, args) {
  ecoEditScheme(null);
},
"economics-24": function (event, args) {
  ecoEditAssignment(null);
},
"economics-25": function (event, args) {
  ecoPayrollCheck();
},
"economics-26": function (event, args) {
  ecoRemoveLine(args[0]);
},
"economics-27": function (event, args) {
  ecoLineField(args[0], 'percent', this.value);
},
"economics-28": function (event, args) {
  ecoLineField(args[0], 'base', this.value);
},
"economics-29": function (event, args) {
  ecoLineField(args[0], 'mult', this.value);
},
"economics-30": function (event, args) {
  ecoLineField(args[0], 'fixed', this.value);
},
"economics-31": function (event, args) {
  _eco.schemeDraft.title = this.value;
},
"economics-32": function (event, args) {
  _eco.schemeDraft.note = this.value;
},
"economics-33": function (event, args) {
  ecoAddLine();
},
"economics-34": function (event, args) {
  ecoSaveScheme();
},
"economics-35": function (event, args) {
  ecoCancelScheme();
},
"economics-36": function (event, args) {
  ecoPickerToggle(args[0], args[1], args[2]);
},
"economics-37": function (event, args) {
  ecoPickerToggle(args[0], args[1], args[2]);
},
"economics-38": function (event, args) {
  ecoPickerFilter(args[0], args[1], this.value);
},
"economics-39": function (event, args) {
  ecoSaveAssignment(args[0]);
},
"economics-40": function (event, args) {
  document.getElementById('ecoAssignForm').innerHTML = '';
},
"economics-41": function (event, args) {
  ecoSaveSettings();
},
"economics-42": function (event, args) {
  ecoRunSync();
},
"economics-43": function (event, args) {
  ecoEditFixed(args[0]);
},
"economics-44": function (event, args) {
  ecoDeleteFixed(args[0]);
},
"economics-45": function (event, args) {
  ecoCopyFixed(args[0]);
},
"economics-46": function (event, args) {
  ecoEditFixed(null);
},
"economics-47": function (event, args) {
  ecoSaveFixed(args[0]);
},
"economics-48": function (event, args) {
  document.getElementById('ecoFixedForm').innerHTML = '';
},
"economics-49": function (event, args) {
  ecoEditEq(args[0]);
},
"economics-50": function (event, args) {
  ecoDeleteEq(args[0]);
},
"economics-51": function (event, args) {
  ecoEditEq(null);
},
"economics-52": function (event, args) {
  ecoSeedEq();
},
"economics-53": function (event, args) {
  ecoSaveEq(args[0]);
},
"economics-54": function (event, args) {
  document.getElementById('ecoEqForm').innerHTML = '';
},
"edocs-board-1": function (event, args) {
  edbSetColor(args[0]);
},
"edocs-board-2": function (event, args) {
  edbSearch(this.value);
},
"edocs-board-3": function (event, args) {
  edbSetRange(args[0]);
},
"edocs-board-4": function (event, args) {
  edOpenAutomation();
},
"edocs-board-5": function (event, args) {
  edbSetChip(args[0]);
},
"edocs-board-6": function (event, args) {
  edOpenAutomation();
},
"edocs-board-7": function (event, args) {
  edGo('settings');
},
"edocs-board-8": function (event, args) {
  edbOpen(args[0], args[1]);
},
"edocs-board-9": function (event, args) {
  event.stopPropagation();
  edbForm(args[0]);
},
"edocs-board-10": function (event, args) {
  event.stopPropagation();
  edbAct(args[0]);
},
"edocs-board-11": function (event, args) {
  event.stopPropagation();
  edbOpen(args[0], 0);
},
"edocs-board-12": function (event, args) {
  event.stopPropagation();
  edbAct(args[0]);
},
"edocs-board-13": function (event, args) {
  edbBaseFilter(args[0]);
},
"edocs-board-14": function (event, args) {
  edbOpen(args[0], 0);
},
"edocs-board-15": function (event, args) {
  edbBasePage(args[0]);
},
"edocs-board-16": function (event, args) {
  edbBasePage(args[0]);
},
"edocs-client-1": function (event, args) {
  edcBack();
},
"edocs-client-2": function (event, args) {
  edcDataToggle(this);
},
"edocs-client-3": function (event, args) {
  edcFormChanged();
},
"edocs-client-4": function (event, args) {
  edcFormChanged();
},
"edocs-client-5": function (event, args) {
  edcRecognize(this);
},
"edocs-client-6": function (event, args) {
  edcPrefill();
},
"edocs-client-7": function (event, args) {
  edFormOpen(args[0]);
},
"edocs-client-8": function (event, args) {
  edcSaveIdentity();
},
"edocs-client-9": function (event, args) {
  event.stopPropagation();
  edcPreview(args[0]);
},
"edocs-client-10": function (event, args) {
  event.stopPropagation();
  edcPaperOpen(args[0]);
},
"edocs-client-11": function (event, args) {
  event.stopPropagation();
  edcEdit(args[0], args[1]);
},
"edocs-client-12": function (event, args) {
  event.stopPropagation();
  edGo("p/" + args[0]);
},
"edocs-client-13": function (event, args) {
  event.stopPropagation();
  edcRemind(args[0]);
},
"edocs-client-14": function (event, args) {
  event.stopPropagation();
  edGo("p/" + args[0]);
},
"edocs-client-15": function (event, args) {
  edcToggle(args[0]);
},
"edocs-client-16": function (event, args) {
  edcToggle(args[0]);
},
"edocs-client-17": function (event, args) {
  event.stopPropagation();
  edcPreview(args[0]);
},
"edocs-client-18": function (event, args) {
  event.stopPropagation();
  edcPaperOpen(args[0]);
},
"edocs-client-19": function (event, args) {
  edcPaperOpen();
},
"edocs-client-20": function (event, args) {
  edcPreviewSelected();
},
"edocs-client-21": function (event, args) {
  edcSend();
},
"edocs-client-22": function (event, args) {
  edcActCell(args[0], args[1], this.value);
},
"edocs-client-23": function (event, args) {
  edcActAdd();
},
"edocs-client-24": function (event, args) {
  edcActReset();
},
"edocs-client-25": function (event, args) {
  edcActSave();
},
"edocs-client-26": function (event, args) {
  edcPreviewAct();
},
"edocs-client-27": function (event, args) {
  edcActCell(args[0], 'include', this.checked);
},
"edocs-client-28": function (event, args) {
  edcDocSave(args[0], args[1]);
},
"edocs-client-29": function (event, args) {
  edcDocSave(args[0], args[1], true);
},
"edocs-client-30": function (event, args) {
  edcPaperSave();
},
"edocs-client-31": function (event, args) {
  closeModal('edPaperModal');
},
"edocs-client-32": function (event, args) {
  edcSetFocus(args[0]);
},
"edocs-client-33": function (event, args) {
  edGo("p/" + args[0]);
},
"edocs-client-34": function (event, args) {
  edFormSend();
},
"edocs-client-35": function (event, args) {
  edFormCopy();
},
"edocs-client-36": function (event, args) {
  edFormRevoke();
},
"edocs-client-37": function (event, args) {
  closeModal('edFormModal');
},
"edocs-1": function (event, args) {
  edSetListStatus(this.value);
},
"edocs-2": function (event, args) {
  edSetListPeriod();
},
"edocs-3": function (event, args) {
  edSetListPeriod();
},
"edocs-4": function (event, args) {
  edGo("p/" + args[0]);
},
"edocs-5": function (event, args) {
  edOpenPdf(args[0]);
},
"edocs-6": function (event, args) {
  edPkgAction(args[0], args[1], this);
},
"edocs-7": function (event, args) {
  edGo("c/" + args[0]);
},
"edocs-8": function (event, args) {
  edOpenScan(args[0]);
},
"edocs-9": function (event, args) {
  edRevokePaper(args[0]);
},
"edocs-10": function (event, args) {
  edOpenInFdoc(args[0]);
},
"edocs-11": function (event, args) {
  edGo("c/" + args[0] + args[1]);
},
"edocs-12": function (event, args) {
  edSaveSettings();
},
"edocs-13": function (event, args) {
  edVerify();
},
"edocs-14": function (event, args) {
  edTariff();
},
"edocs-15": function (event, args) {
  edOpenAutomation();
},
"edocs-16": function (event, args) {
  edSubscribe();
},
"edocs-17": function (event, args) {
  edUploadTemplate();
},
"edocs-18": function (event, args) {
  edSaveTemplate(args[0]);
},
"edocs-19": function (event, args) {
  edTemplateFile(args[0]);
},
"edocs-20": function (event, args) {
  edReplaceTemplate(args[0], this);
},
"edocs-21": function (event, args) {
  edDeleteTemplate(args[0]);
},
"edocs-22": function (event, args) {
  edTgl(this);
},
"edocs-23": function (event, args) {
  edSaveAutomation();
},
"edocs-24": function (event, args) {
  closeModal('edAutoModal');
},
"edocs-25": function (event, args) {
  edOpenClient(args[0]);
},
"edocs-26": function (event, args) {
  edOpenPackage(args[0]);
},
"edocs-27": function (event, args) {
  edOpenPackage(args[0]);
},
"edocs-28": function (event, args) {
  edOpenClient(args[0], args[1]);
},
"home-care-1": function (event, args) {
  hcOpenEdit(args[0]);
},
"home-care-2": function (event, args) {
  event.stopPropagation();
},
"home-care-3": function (event, args) {
  openAdherenceModal(args[0]);
},
"home-care-4": function (event, args) {
  hcPrintById(args[0]);
},
"home-care-5": function (event, args) {
  hcDownloadPdf(args[0]);
},
"home-care-6": function (event, args) {
  hcOpenSendModal(args[0]);
},
"home-care-7": function (event, args) {
  hcOpenEdit(args[0]);
},
"home-care-8": function (event, args) {
  hcDelete(args[0]);
},
"home-care-9": function (event, args) {
  hcPage--;
  hcFetch();
},
"home-care-10": function (event, args) {
  hcPage++;
  hcFetch();
},
"home-care-11": function (event, args) {
  hcAcSearch(this);
},
"home-care-12": function (event, args) {
  hcAcSearch(this);
},
"home-care-13": function (event, args) {
  hcOpenPicker(args[0], args[1]);
},
"home-care-14": function (event, args) {
  this.closest('.hc-item').remove();
},
"home-care-15": function (event, args) {
  hcAcSelect(event, args[0], args[1]);
},
"home-care-16": function (event, args) {
  hcPickerToggle(args[0]);
},
"journal-card-1": function (event, args) {
  jrStockTab('services');
},
"journal-card-2": function (event, args) {
  jrStockTab('goods');
},
"journal-dispatch-1": function (event, args) {
  jrClose(true);
},
"journal-dispatch-2": function (event, args) {
  jrClose(true);
},
"journal-staff-menu-1": function (event, args) {
  jrScheduleChangesOpen();
},
"journal-staff-menu-2": function (event, args) {
  jrClose(true);
},
"journal-stock-1": function (event, args) {
  jrStockEdit(args[0]);
},
"journal-stock-2": function (event, args) {
  jrStockSave(args[0]);
},
"medical-cert-coords-editor-1": function (event, args) {
  mcPanelEdit(args[0]);
},
"medical-cert-1": function (event, args) {
  mcTogglePatient();
},
"medical-cert-2": function (event, args) {
  mcPickClient(this);
},
"medical-cert-3": function (event, args) {
  mcSaveCoords();
},
"notifications-1": function (event, args) {
  ntLoad();
},
"notifications-2": function (event, args) {
  ntOpenEditor(null, args[0]);
},
"notifications-3": function (event, args) {
  ntToggle(args[0]);
},
"notifications-4": function (event, args) {
  ntOpenEditor(args[0]);
},
"notifications-5": function (event, args) {
  ntOpenEditor(args[0]);
},
"notifications-6": function (event, args) {
  ntInsertVar(args[0]);
},
"notifications-7": function (event, args) {
  ntTextChanged();
},
"notifications-8": function (event, args) {
  ntOnFile(this);
},
"notifications-9": function (event, args) {
  ntDeleteAttachment();
},
"notifications-10": function (event, args) {
  ntMoveCh(args[0], -1);
},
"notifications-11": function (event, args) {
  ntMoveCh(args[0], 1);
},
"notifications-12": function (event, args) {
  ntToggleCh(args[0]);
},
"notifications-13": function (event, args) {
  ntToggleCh(args[0]);
},
"notifications-14": function (event, args) {
  ntJobsPage(-1);
},
"notifications-15": function (event, args) {
  ntJobsPage(1);
},
"notifications-16": function (event, args) {
  ntCancelJob(args[0]);
},
"patient-portfolio-1": function (event, args) {
  _ppBack(1);
},
"patient-portfolio-2": function (event, args) {
  _ppNewVisit();
},
"patient-portfolio-3": function (event, args) {
  _ppNewCourse();
},
"patient-portfolio-4": function (event, args) {
  _ppBack(2);
},
"portfolio-1": function (event, args) {
  openPortfolioCategory(args[0]);
},
"portfolio-2": function (event, args) {
  this.style.boxShadow = '0 4px 16px rgba(0,0,0,.10)';
},
"portfolio-3": function (event, args) {
  this.style.boxShadow = '';
},
"portfolio-4": function (event, args) {
  openPortfolioItemEdit(args[0]);
},
"portfolio-5": function (event, args) {
  this.style.boxShadow = '0 4px 16px rgba(0,0,0,.10)';
},
"portfolio-6": function (event, args) {
  this.style.boxShadow = '';
},
"records-1": function (event, args) {
  loadRecords(args[0]);
},
"records-2": function (event, args) {
  loadRecords(args[0]);
},
"records-3": function (event, args) {
  loadRecords(args[0]);
},
"reminders-1": function (event, args) {
  remToggleRule(args[0]);
},
"reminders-2": function (event, args) {
  remOpenTest(args[0]);
},
"reminders-3": function (event, args) {
  remOpenBackfill(args[0]);
},
"reminders-4": function (event, args) {
  remOpenRuleModal(args[0]);
},
"reminders-5": function (event, args) {
  remDeleteRule(args[0]);
},
"reminders-6": function (event, args) {
  remRemoveTier(args[0]);
},
"reminders-7": function (event, args) {
  remTierField(args[0], 'upTo', this.value);
},
"reminders-8": function (event, args) {
  remTierField(args[0], 'action', this.value);
},
"reminders-9": function (event, args) {
  remTierField(args[0], 'text', this.value);
},
"reminders-10": function (event, args) {
  remTierField(args[0], 'amount', this.value);
},
"reminders-11": function (event, args) {
  remPickPlanDay(args[0]);
},
"reminders-12": function (event, args) {
  event.preventDefault();
  remPickPlanDay(null);
},
"reminders-13": function (event, args) {
  remCancelQueued(args[0]);
},
"reminders-14": function (event, args) {
  remToggleMute(args[0], args[1], args[2]);
},
"segments-1": function (event, args) {
  if (!args[0]) segOpenDrawer(args[1]);
},
"segments-2": function (event, args) {
  event.stopPropagation();
},
"segments-3": function (event, args) {
  segDrawerGo(args[0]);
},
"segments-4": function (event, args) {
  segDrawerGo(args[0]);
},
"settings-1": function (event, args) {
  sendBdB(args[0]);
},
"settings-2": function (event, args) {
  loadStaffProfiles(args[0]);
},
"settings-3": function (event, args) {
  openStaffModal(args[0]);
},
"settings-4": function (event, args) {
  this.style.boxShadow = '0 4px 16px rgba(0,0,0,.10)';
},
"settings-5": function (event, args) {
  this.style.boxShadow = '';
},
"staff-1": function (event, args) {
  sgSave(args[0], this);
},
"stock-balances-1": function (event, args) {
  stockOpenGood(args[0]);
},
"stock-balances-2": function (event, args) {
  stockGoodMovements(args[0]);
},
"stock-balances-3": function (event, args) {
  stockGoodMovements(args[0]);
},
"stock-docs-1": function (event, args) {
  stockExportOperations();
},
"stock-docs-2": function (event, args) {
  stockSaleOpen();
},
"stock-docs-3": function (event, args) {
  stockDocumentOpen('receipt');
},
"stock-docs-4": function (event, args) {
  stockDocumentOpen('writeoff');
},
"stock-docs-5": function (event, args) {
  stockDocumentOpen('move');
},
"stock-docs-6": function (event, args) {
  event.preventDefault();
  stockLoadDocs(1);
},
"stock-docs-7": function (event, args) {
  stockOpenOperationVisit(args[0]);
},
"stock-docs-8": function (event, args) {
  stockOpenDocument(args[0]);
},
"stock-docs-9": function (event, args) {
  stockOpenDocument(args[0]);
},
"stock-docs-10": function (event, args) {
  stockOpenGood(args[0]);
},
"stock-docs-11": function (event, args) {
  stockOpenOperationHistory(args[0]);
},
"stock-docs-12": function (event, args) {
  stockLoadDocs(args[0], true);
},
"stock-docs-13": function (event, args) {
  stockLoadDocs(args[0], true);
},
"stock-docs-14": function (event, args) {
  stockOpenDocument(args[0]);
},
"stock-docs-15": function (event, args) {
  stockDocumentClose();
  navTo('journal');
  jrOpen(args[0]);
},
"stock-docs-16": function (event, args) {
  stockCancelDocument(args[0]);
},
"stock-docs-17": function (event, args) {
  stockPaySale(args[0]);
},
"stock-docs-18": function (event, args) {
  stockSearchGoods(args[0], this.value);
},
"stock-docs-19": function (event, args) {
  stockLineGood(args[0], args[1], this.value);
},
"stock-docs-20": function (event, args) {
  stockRemoveLine(args[0], args[1]);
},
"stock-docs-21": function (event, args) {
  stockSearchGoods(args[0], this.value);
},
"stock-docs-22": function (event, args) {
  stockLineGood(args[0], args[1], this.value);
},
"stock-docs-23": function (event, args) {
  stockRemoveLine(args[0], args[1]);
},
"stock-docs-24": function (event, args) {
  stockUpdateTotal('stockDoc');
},
"stock-docs-25": function (event, args) {
  stockAddLine('stockDoc');
},
"stock-inventory-1": function (event, args) {
  stockNewInventory();
},
"stock-inventory-2": function (event, args) {
  stockOpenInventory(args[0]);
},
"stock-inventory-3": function (event, args) {
  stockInventoryChanged(args[0], this.value);
},
"stock-inventory-4": function (event, args) {
  stockPostInventory();
},
"stock-inventory-5": function (event, args) {
  event.preventDefault();
  stockLoadTurnover();
},
"stock-inventory-6": function (event, args) {
  stockExportTurnover();
},
"stock-refs-1": function (event, args) {
  stockEditRef(args[0]);
},
"stock-refs-2": function (event, args) {
  stockEditRef(args[0], args[1]);
},
"stock-refs-3": function (event, args) {
  stockDeleteSupplier(args[0]);
},
"stock-refs-4": function (event, args) {
  stockSaveSettings(event);
},
"stock-sale-1": function (event, args) {
  stockSaleSearchClients(this.value);
},
"stock-sale-2": function (event, args) {
  stockSaleChangeClient();
},
"stock-sale-3": function (event, args) {
  stockUpdateTotal('stockSale');
},
"stock-sale-4": function (event, args) {
  stockAddLine('stockSale');
},
"stock-sale-5": function (event, args) {
  stockSaleShowGoods();
},
"stock-sale-6": function (event, args) {
  stockSaleRenderGoodsList(this.value);
},
"stock-sale-7": function (event, args) {
  stockGiftChanged();
},
"users-1": function (event, args) {
  if (event.target === this) usersCloseModal();
},
"users-2": function (event, args) {
  usersCloseModal();
},
"users-3": function (event, args) {
  usersSave(args[0], args[1]);
},
"users-4": function (event, args) {
  usersCloseModal();
}
});
