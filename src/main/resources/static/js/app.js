const state = {
    userStory: '',
    entryPoint: '',
    actions: []
};

function nextStep(step) {
    saveCurrentState();
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById('step-' + step).classList.add('active');

    if (step === 4) {
        renderFlowPreview();
    }
}

function prevStep(step) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById('step-' + step).classList.add('active');
}

function saveCurrentState() {
    state.userStory = document.getElementById('user-story').value;
    state.entryPoint = document.getElementById('entry-point').value;

    const actionRows = document.querySelectorAll('.action-row');
    state.actions = Array.from(actionRows).map(row => {
        const inputs = row.querySelectorAll('input');
        return {
            method: inputs[0].value,
            collaborator: inputs[1].value,
            returnValue: inputs[2].value
        };
    });
}

function addAction() {
    const list = document.getElementById('actions-list');
    const row = document.createElement('div');
    row.className = 'action-row';
    row.innerHTML = `
        <input type="text" placeholder="Method name (e.g., validate)">
        <input type="text" placeholder="Who does it? (e.g., InventoryService)">
        <input type="text" placeholder="Returns? (e.g., result : Boolean)">
        <button class="remove-btn" onclick="this.parentElement.remove()">x</button>
    `;
    list.appendChild(row);
}

function renderFlowPreview() {
    saveCurrentState();
    const preview = document.getElementById('flow-preview');

    if (state.actions.length === 0) {
        preview.innerHTML = '<p>No actions defined. Go back and add some.</p>';
        return;
    }

    let html = '';
    state.actions.forEach(action => {
        if (action.method || action.collaborator) {
            html += `
                <div class="flow-arrow">
                    <span class="flow-caller">${state.entryPoint || '?'}</span>
                    <span class="flow-direction">&rarr;</span>
                    <span class="flow-callee">${action.collaborator || '?'}</span>
                    <span class="flow-method">: ${action.method || '?'}()</span>
                </div>
            `;
            if (action.returnValue) {
                html += `
                    <div class="flow-arrow">
                        <span class="flow-callee">${action.collaborator || '?'}</span>
                        <span class="flow-direction">&larr;</span>
                        <span class="flow-caller">${state.entryPoint || '?'}</span>
                        <span class="flow-method">: ${action.returnValue}</span>
                    </div>
                `;
            }
        }
    });

    preview.innerHTML = html || '<p>No valid actions to display.</p>';
}

function generate() {
    saveCurrentState();

    const output = {
        userStory: state.userStory,
        entryPoint: state.entryPoint,
        actions: state.actions.filter(a => a.method && a.collaborator)
    };

    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById('step-5').classList.active = true;
    document.getElementById('step-5').classList.add('active');
    document.getElementById('output').textContent = JSON.stringify(output, null, 2);
}

// Add one action row by default
document.addEventListener('DOMContentLoaded', () => {
    addAction();
});
