/* Shared, transient translation input; never store task instructions in preferences. */
(function (PR) {
  "use strict";
  PR.translationExtraHtml = () => '<details class="translation-extra"><summary>' + PR.t("本次补充要求（选填）") + '</summary><textarea class="input" data-translation-extra rows="3" maxlength="4000" aria-label="' + PR.t("本次补充要求（选填）") + '" placeholder="' + PR.t("例如：这篇论文中的 agent 保留英文") + '"></textarea><p class="hint">' + PR.t("仅用于本次翻译；长期规则可在设置中编辑翻译提示词") + '</p></details>';

  PR.translationDialog = function (options = {}) {
    return new Promise(resolve => {
      const editor = options.editor;
      const backdrop = PR.el('div', {class:'dialog-backdrop open translation-dialog'},
        '<div class="dialog" role="dialog" aria-modal="true" aria-label="' + PR.esc(options.title || PR.t("开始翻译")) + '"><h2>' + PR.esc(options.title || PR.t("开始翻译")) + '</h2>' +
        (options.body ? '<p class="hint">' + PR.esc(options.body) + '</p>' : '') +
        (editor ? '<textarea class="input translation-prompt-editor" data-translation-extra maxlength="12000" rows="10" aria-label="' + PR.t("翻译提示词") + '"></textarea>' : PR.translationExtraHtml()) +
        '<div class="actions">' + (editor ? '<button class="btn line" data-translation-reset>' + PR.t("恢复默认") + '</button><span class="grow"></span>' : '') +
        '<button class="btn" data-translation-cancel>' + PR.t("取消") + '</button><button class="btn primary" data-translation-go>' + PR.esc(options.ok || PR.t("开始翻译")) + '</button></div></div>');
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector('textarea'), go = backdrop.querySelector('[data-translation-go]');
      input.value = options.value || '';
      if (!editor && input.value) backdrop.querySelector('details').open = true;
      let saving = false, downOnBackdrop = false;
      const close = value => { if (saving) return; document.removeEventListener('keydown', onKey, true); backdrop.remove(); resolve(value); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('pointerdown', e => { downOnBackdrop = e.target === backdrop; });
      backdrop.addEventListener('click', async e => {
        if ((e.target === backdrop && downOnBackdrop) || e.target.closest('[data-translation-cancel]')) return close(null);
        if (e.target.closest('[data-translation-reset]')) { input.value = options.defaultValue; input.focus(); return; }
        if (!e.target.closest('[data-translation-go]') || saving) return;
        const value = input.value.trim();
        if (editor && !value) { input.focus(); return PR.toast(PR.t("翻译提示词不能为空，最多 12000 字")); }
        saving = true;
        backdrop.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
        try { if (options.save) await options.save(value); saving = false; close(value); }
        catch (err) { saving = false; backdrop.querySelectorAll('button, textarea').forEach(el => { el.disabled = false; }); PR.toast(err.message); }
      });
      (editor ? input : go).focus();
    });
  };

  PR.startTranslation = async function (id, body = {}, options = {}) {
    const extra = await PR.translationDialog(options);
    if (extra === null) return false;
    await PR.api('/api/p/' + id + '/translate', {method:'POST', body:{...body, translation_extra:extra}});
    return true;
  };

  PR.editTranslationPrompt = function () {
    const cfg = PR.settingsState.cfg;
    return PR.translationDialog({editor:true, title:PR.t("翻译提示词"), ok:PR.t("保存"),
      body:PR.t("论文译成：{lang}", {lang:PR.targetName(cfg.target || PR.target)}) + '\n' + PR.t("默认提示词跟随界面语言；自行编辑的内容保留原文。格式、公式和逐句对齐由程序保留"),
      value:cfg.translation_prompt_effective, defaultValue:cfg.translation_prompt_default,
      save:async value => {
        await PR.saveModelSettings();
        const result = await PR.api('/api/config', {method:'POST', body:{translation_prompt:value === cfg.translation_prompt_default ? null : value, translation_instructions:''}});
        Object.assign(cfg, {translation_prompt:result.config.translation_prompt, translation_prompt_effective:result.config.translation_prompt_effective, translation_instructions:''});
        PR.toast(PR.t("已保存"));
      }});
  };
})(window.PR);
