'use strict';
document.body.replaceChildren();
window.NativeChat = {
  hasSession: () => Boolean(document.querySelector('#first-reply')),
  reset() { document.querySelector('#cpChat')?.replaceChildren(); },
  // The production starter computes the runtime and permission for this submission.
  // Use its result to open the real desktop bridge; show the returned answer in the chat host.
  async enter(text, sessionId, options) {
    if (sessionId) throw Error('Expected a new chat');
    const output = document.createElement('output');
    output.id = 'first-reply';
    output.dataset.state = 'waiting';
    const transcript = document.createElement('dl');
    transcript.style.cssText = 'max-width: 680px; margin: 64px auto; font-size: 16px; line-height: 1.6';
    for (const [role, contents] of [['User', text], ['Planning Harness', output]]) {
      const speaker = document.createElement('dt'), message = document.createElement('dd');
      speaker.textContent = role;
      message.append(contents);
      transcript.append(speaker, message);
    }
    document.querySelector('#cpChat').append(transcript);
    try {
      output.textContent = await soduWorkAPI.firstPlanningTurn(text, options);
      output.dataset.state = 'answered';
      return true;
    } catch (error) {
      output.textContent = error.message;
      output.dataset.state = 'failed';
      return false;
    }
  },
};
window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };
window.User = { id: 'test-device', name: 'Fixture' };
window.esc = value => String(value ?? '').replace(/[<>&"]/g, ch => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
})[ch]);

// The real management handler, local Runner, installation and ACP probe run outside this renderer.
window.fetch = async url => {
  const machine = {
    runnerId: 'synthetic-desktop', scope: 'current-instance', online: true, isCurrentDevice: true,
    env: { node: 'v22', ok: true }, agents: [{ key: 'pi', name: 'Pi', installed: true, state: 'ready' }],
  };
  const body = new URL(url).pathname.endsWith('/runners') ? { runners: [machine] } :
    { machines: [machine], agents: machine.agents, env: machine.env, modelCount: 1, models: [{ name: 'synthetic-model' }] };
  return new Response(JSON.stringify(body));
};
