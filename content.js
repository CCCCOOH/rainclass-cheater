// ==Chrome Extension==
// 名称: 考试题目自动提取
// 描述: 自动读取所有题目的题目、选项信息，支持选择/填空/主观题，鼠标悬浮题目文字加黑高亮，点击题目自动答题
// 版本: 2.5
// ==Chrome Extension==

(function() {
    'use strict';

    // DeepSeek API 配置
    const API_CONFIG = {
        url: 'https://api.deepseek.com',
        key: 'sk-c458053961fd438bbcee6c8226696177',
        model: 'deepseek-v4-flash'
    };

    // ============ 题型检测与选项提取 ============

    // 题型枚举
    const QUESTION_TYPES = {
        SINGLE_CHOICE: 'single_choice',
        MULTI_CHOICE: 'multi_choice',
        FILL_BLANK: 'fill_blank',
        SUBJECTIVE: 'subjective',
        UNKNOWN: 'unknown'
    };

    // 检测题目类型
    function detectQuestionType(subjectItem) {
        // 判断题/选择题：存在选项列表
        const radioList = subjectItem.querySelector('.list-unstyled-radio');
        const checkboxList = subjectItem.querySelector('.list-unstyled-checkbox');
        if (checkboxList) return QUESTION_TYPES.MULTI_CHOICE;
        if (radioList) return QUESTION_TYPES.SINGLE_CHOICE;

        // 备用：通过 input 类型判断
        const radioInputs = subjectItem.querySelectorAll('input[type="radio"]');
        const checkboxInputs = subjectItem.querySelectorAll('input[type="checkbox"]');
        if (checkboxInputs.length > 0) return QUESTION_TYPES.MULTI_CHOICE;
        if (radioInputs.length > 0) return QUESTION_TYPES.SINGLE_CHOICE;

        // 主观题：存在 UEditor iframe 或 contenteditable
        if (subjectItem.querySelector('.ueditor-content iframe') ||
            subjectItem.querySelector('[contenteditable="true"]')) {
            return QUESTION_TYPES.SUBJECTIVE;
        }

        // 填空题：存在可见的 input 或 textarea（排除 radio/checkbox/hidden）
        const inputs = findBlankInputs(subjectItem);
        if (inputs.length > 0) return QUESTION_TYPES.FILL_BLANK;

        // 通过题型文本辅助判断
        const typeText = subjectItem.querySelector('.item-type')?.innerText || '';
        if (/判断题|判断/.test(typeText)) {
            return QUESTION_TYPES.SINGLE_CHOICE; // 判断题本质上也是二选一
        }
        if (/单选题|单选/.test(typeText)) return QUESTION_TYPES.SINGLE_CHOICE;
        if (/多选题|多选/.test(typeText)) return QUESTION_TYPES.MULTI_CHOICE;
        if (/填空/.test(typeText)) return QUESTION_TYPES.FILL_BLANK;
        if (/主观|简答|论述|问答|分析|名词解释|计算/.test(typeText)) return QUESTION_TYPES.SUBJECTIVE;

        return QUESTION_TYPES.UNKNOWN;
    }

    // 提取选择题选项信息
    function extractChoiceOptions(subjectItem) {
        const optionItems = subjectItem.querySelectorAll('.list-unstyled-radio > li, .list-unstyled-checkbox > li');
        if (optionItems.length === 0) {
            // 备用：Element UI 风格：直接查找 label.el-radio / label.el-checkbox
            const labels = subjectItem.querySelectorAll('label.el-radio, label.el-checkbox');
            return Array.from(labels).map((label, i) => ({
                label: String.fromCharCode(65 + i),
                text: label.innerText?.trim() || '',
                element: label
            }));
        }

        return Array.from(optionItems).map((li, index) => {
            const labelEl = li.querySelector('.radioInput, .checkboxInput');
            const textEl = li.querySelector('.radioText, .checkboxText');
            const valueInput = li.querySelector('input[value]');
            const rawLabel = (labelEl?.innerText || valueInput?.value || '').trim();
            const label = normalizeOptionKey(rawLabel) || String.fromCharCode(65 + index);
            const text = textEl ? textEl.innerText.trim() : li.innerText.replace(rawLabel, '').trim();
            // 关键：element 必须指向可点击的 <label class="el-radio"> 而不是 <li>
            // Element UI 的选中状态 (is-checked) 和点击事件都绑定在 label 上
            const clickableLabel = li.querySelector('label.el-radio, label.el-checkbox');
            return { label, text, element: clickableLabel || li };
        });
    }

    // 查找填空题输入框
    function findBlankInputs(subjectItem) {
        return Array.from(subjectItem.querySelectorAll('textarea, input')).filter(el => {
            const type = (el.type || '').toLowerCase();
            return !/^(radio|checkbox|hidden|button|submit|reset|file)$/i.test(type);
        });
    }

    // 标准化选项键
    function normalizeOptionKey(value) {
        const text = String(value || '').replace(/\s+/g, '').trim();
        if (!text) return '';
        if (/^(true|正确|对|是)$/i.test(text)) return 'T';
        if (/^(false|错误|错|否)$/i.test(text)) return 'F';
        return text.charAt(0).toUpperCase();
    }

    // 解析 AI 返回的选择题答案为字母数组
    function parseChoiceAnswer(answer) {
        const clean = String(answer || '')
            .replace(/[，、；;|/]+/g, ' ')
            .replace(/\bTRUE\b/ig, 'T')
            .replace(/\bFALSE\b/ig, 'F')
            .replace(/正确|对|是/g, 'T')
            .replace(/错误|错|否/g, 'F');

        const tokens = clean.match(/[A-Z]|T|F/g);
        return Array.from(new Set((tokens || []).map(t => normalizeOptionKey(t)).filter(Boolean)));
    }

    // 拆分填空答案为多段
    function splitBlankAnswer(answer, inputCount) {
        const clean = String(answer || '').trim();
        if (inputCount <= 1) return [clean];

        // 纯字母序列：A B C → ['A', 'B', 'C']
        if (/^[A-Z](?:[\s,，、;；]+[A-Z])+$/.test(clean)) {
            return clean.split(/[\s,，、;；]+/).filter(Boolean);
        }

        // 按换行拆分
        const byLine = clean.split(/\n+/).map(v => v.trim()).filter(Boolean);
        if (byLine.length === inputCount) return byLine;

        // 按 | 或 ； 拆分
        const bySep = clean.split(/[|；;]/).map(v => v.trim()).filter(Boolean);
        if (bySep.length === inputCount) return bySep;

        return [clean];
    }

    // 设置 input/textarea 的值并触发双向绑定事件（兼容 Vue/React）
    function setNativeValue(input, value) {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) {
            descriptor.set.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // QUESTION_BANK 定义在 question-bank.js 中，以全局变量形式提供

    // 样式定义
    const styles = `
        .clearfix.exam-font.ai-answerable {
            cursor: pointer;
        }
    `;

    // 注入样式
    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    // 提取题目信息
    function extractQuestionInfo(subjectItem) {
        const itemBody = subjectItem.querySelector('.item-body');
        if (!itemBody) return null;

        // 优先从 h4 提取题干
        const h4 = itemBody.querySelector('h4');
        let questionText = h4 ? h4.textContent.trim() : '';

        const questionType = detectQuestionType(subjectItem);

        // 填空题：题干通常在 .exam-font 的 span 文本中（没有 h4 标签）
        if (!questionText && questionType === QUESTION_TYPES.FILL_BLANK) {
            const examFont = itemBody.querySelector('.exam-font');
            if (examFont) {
                // 提取所有 span 文本拼接（跳过仅含空白的 span）
                const spans = examFont.querySelectorAll('span');
                questionText = Array.from(spans)
                    .map(s => s.textContent.trim())
                    .filter(t => t.length > 0)
                    .join('');
            }
        }

        // 兜底：取 .item-body 内所有可见文本，排除选项列表和 ueditor
        if (!questionText) {
            const clone = itemBody.cloneNode(true);
            clone.querySelectorAll('.list-unstyled-radio, .list-unstyled-checkbox, .ueditor-content, .el-radio, .el-checkbox').forEach(el => el.remove());
            questionText = clone.textContent.trim();
        }

        // 收集试卷所有题目
        const examContent = subjectItem.closest('.exam-main--content');
        let allQuestions = '';
        if (examContent) {
            const allSubjectItems = examContent.querySelectorAll('.subject-item');
            allSubjectItems.forEach(item => {
                const itemH4 = item.querySelector('.item-body h4');
                const itemType = item.querySelector('.item-type');
                if (itemType) {
                    const typeText = itemType.textContent.trim();
                    let qText = '';
                    if (itemH4) {
                        qText = itemH4.textContent.trim();
                    } else {
                        // 填空题：从 .exam-font 提取
                        const ef = item.querySelector('.item-body .exam-font');
                        if (ef) {
                            qText = Array.from(ef.querySelectorAll('span'))
                                .map(s => s.textContent.trim())
                                .filter(t => t.length > 0)
                                .join('');
                        }
                        if (!qText) {
                            const ib = item.querySelector('.item-body');
                            if (ib) {
                                const c = ib.cloneNode(true);
                                c.querySelectorAll('.ueditor-content').forEach(e => e.remove());
                                qText = c.textContent.trim();
                            }
                        }
                    }
                    if (qText) {
                        allQuestions += `${typeText}\n${qText}\n\n`;
                    }
                }
            });
        }

        const info = {
            questionText,
            allQuestions,
            subjectItem,
            questionType
        };

        // 选择题：提取选项
        if (questionType === QUESTION_TYPES.SINGLE_CHOICE || questionType === QUESTION_TYPES.MULTI_CHOICE) {
            info.options = extractChoiceOptions(subjectItem);
        }

        // 填空题：记录输入框数量
        if (questionType === QUESTION_TYPES.FILL_BLANK) {
            const inputs = findBlankInputs(subjectItem);
            info.blankInputCount = inputs.length;
        }

        return info;
    }

    // 调用 DeepSeek API
    async function callDeepSeekAPI(questionInfo) {
        let prompt;
        let systemPrompt = '你是一个专业的大数据课程助教，负责为学生提供准确的答案。';

        switch (questionInfo.questionType) {
            case QUESTION_TYPES.SINGLE_CHOICE:
            case QUESTION_TYPES.MULTI_CHOICE:
                // 选择题 prompt
                const choiceType = questionInfo.questionType === QUESTION_TYPES.SINGLE_CHOICE ? '单选题' : '多选题';
                const optionsText = (questionInfo.options || []).map(o => `${o.label}. ${o.text}`).join('\n');
                prompt = `你是一个专业的大数据课程助教。请根据以下题库内容，为这道${choiceType}选择正确答案。

【题库内容】
${QUESTION_BANK}

【试卷所有题目】
${questionInfo.allQuestions}

【当前题目】
${questionInfo.questionText}

【选项】
${optionsText}

请严格按照以下要求作答：
1. 首先在题库中精确匹配当前题目，找到对应的标准答案
2. 如果是单选题，只输出一个选项字母（如 A 或 T）
3. 如果是多选题，输出所有正确选项字母，用逗号分隔（如 A,B,C）
4. 如果是判断题，输出 T（正确/对）或 F（错误/错）
5. 只输出答案字母，不要包含任何解释、解析或额外文字
6. 纯文本输出，不要用markdown

请直接输出答案：`;
                break;

            case QUESTION_TYPES.FILL_BLANK:
                // 填空题 prompt
                const blankHint = questionInfo.blankInputCount > 1
                    ? `\n5. 题目有 ${questionInfo.blankInputCount} 个空，请用 "|" 符号分隔每个空的答案（如：答案1|答案2|答案3）`
                    : '';
                prompt = `你是一个专业的大数据课程助教。请根据以下题库内容，为这道填空题提供标准答案。

【题库内容】
${QUESTION_BANK}

【试卷所有题目】
${questionInfo.allQuestions}

【当前题目】
${questionInfo.questionText}

请严格按照以下要求作答：
1. 首先在题库中精确匹配当前题目，找到对应的标准答案
2. 如果题库中有完全匹配的题目，直接输出题库中的填空答案
3. 如果题库中没有完全匹配的题目，请根据题库中的相关知识给出答案
4. 答案应该简洁准确${blankHint}
5. 只输出填空内容，不要包含任何解释性文字
6. 纯文本输出，不要用markdown

请直接输出答案：`;
                break;

            case QUESTION_TYPES.SUBJECTIVE:
            default:
                // 主观题 prompt（保持原有逻辑）
                prompt = `你是一个专业的大数据课程助教。请根据以下题库内容，为指定的主观题提供标准答案。

【题库内容】
${QUESTION_BANK}

【试卷所有题目】
${questionInfo.allQuestions}

【当前需要作答的主观题】
${questionInfo.questionText}

请严格按照以下要求作答：
1. 首先在题库中精确匹配当前题目，找到对应的标准答案
2. 如果题库中有完全匹配的题目，直接输出题库中的完整答案
3. 如果题库中没有完全匹配的题目，请根据题库中的相关知识，组织一个专业、完整的答案
4. 答案应该条理清晰，分点论述
5. 只输出答案内容，不要包含任何解释性文字
6. 保持题库原有的格式和风格
7. 纯文本输出不要用markdown
8. 如果答案很长，对每个长句用一句话精简概括核心内容

请直接输出答案：`;
                break;
        }

        const response = await fetch(`${API_CONFIG.url}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_CONFIG.key}`
            },
            body: JSON.stringify({
                model: API_CONFIG.model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 4000,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error(`API请求失败: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    // 点击选项元素
    function clickOption(optionEl) {
        // 优先点击 label 或 Element UI 组件，确保状态正确
        const target = optionEl.matches('label, .el-radio, .el-checkbox, li') ?
            optionEl :
            optionEl.querySelector('label, .el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"]') || optionEl;
        target.click();
        console.log('🖱️ 已点击选项:', target);
    }

    // 判断选项是否已选中
    function isOptionChecked(optionEl) {
        const input = optionEl.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input?.checked) return true;
        return optionEl.matches('.is-checked') ||
            !!optionEl.querySelector('.is-checked, [aria-checked="true"]');
    }

    // 填入选择题答案
    function fillChoiceAnswer(subjectItem, answer) {
        const options = extractChoiceOptions(subjectItem);
        if (options.length === 0) {
            console.error('未找到选项');
            return false;
        }

        const wanted = parseChoiceAnswer(answer);
        if (wanted.length === 0) {
            console.error('无法解析的选择题答案:', answer);
            return false;
        }

        const questionType = detectQuestionType(subjectItem);
        const isMultiple = questionType === QUESTION_TYPES.MULTI_CHOICE;
        let changed = 0;

        console.log(`🎯 期望答案: ${wanted.join(', ')}, 题型: ${isMultiple ? '多选' : '单选'}`);

        options.forEach((option) => {
            if (!wanted.includes(option.label)) return;
            // 单选：已选中的不再点（防止取消选中）
            // 多选：已选中的跳过（保留已选）
            if (isMultiple && isOptionChecked(option.element)) return;
            if (!isMultiple && isOptionChecked(option.element)) return;
            clickOption(option.element);
            changed++;
        });

        console.log(`✅ 已勾选 ${changed} 个选项`);
        return changed > 0;
    }

    // 填入填空题答案
    function fillBlankAnswer(subjectItem, answer) {
        const inputs = findBlankInputs(subjectItem);
        if (inputs.length === 0) {
            console.error('未找到填空输入框');
            return false;
        }

        const parts = splitBlankAnswer(answer, inputs.length);
        let filled = 0;

        inputs.forEach((input, index) => {
            const value = parts[index] ?? parts[0] ?? '';
            if (value) {
                setNativeValue(input, value);
                filled++;
            }
        });

        console.log(`✅ 已填入 ${filled}/${inputs.length} 个填空`);
        return filled > 0;
    }

    // 统一的答案填入分发函数
    function fillAnswer(subjectItem, answer, questionType) {
        switch (questionType) {
            case QUESTION_TYPES.SINGLE_CHOICE:
            case QUESTION_TYPES.MULTI_CHOICE:
                return fillChoiceAnswer(subjectItem, answer);
            case QUESTION_TYPES.FILL_BLANK:
                return fillBlankAnswer(subjectItem, answer);
            case QUESTION_TYPES.SUBJECTIVE:
            case QUESTION_TYPES.UNKNOWN:
            default:
                return fillAnswerToEditor(subjectItem, answer);
        }
    }

    // 将答案填入编辑器（主观题 UEditor）
    function fillAnswerToEditor(subjectItem, answer) {
        const iframe = subjectItem.querySelector('.ueditor-content iframe');
        if (!iframe) {
            console.error('未找到编辑器iframe');
            return false;
        }

        try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const body = doc.body;

            body.innerHTML = '';

            const htmlContent = answer
                .split('\n')
                .map(line => {
                    line = line.trim();
                    if (!line) return '<br>';
                    return `<p>${line}</p>`;
                })
                .join('');

            body.innerHTML = htmlContent;

            const event = new Event('input', { bubbles: true });
            body.dispatchEvent(event);

            const changeEvent = new Event('change', { bubbles: true });
            body.dispatchEvent(changeEvent);

            const keyupEvent = new KeyboardEvent('keyup', { bubbles: true });
            body.dispatchEvent(keyupEvent);

            return true;
        } catch (e) {
            console.error('填充答案失败:', e);
            return false;
        }
    }

    // 触发单个题目的AI答题
    async function triggerAnswerForSubject(subjectItem) {
        // 防止对同一题目重复触发
        if (subjectItem.dataset.aiBusy === 'true') return;
        const questionInfo = extractQuestionInfo(subjectItem);
        if (!questionInfo || !questionInfo.questionText) {
            console.warn('❌ 未找到题目');
            return;
        }
        subjectItem.dataset.aiBusy = 'true';
        console.log('🤖 开始AI答题...');
        try {
            const answer = await callDeepSeekAPI(questionInfo);
            const filled = fillAnswer(subjectItem, answer, questionInfo.questionType);
            if (filled) {
                console.log('✅ AI答题完成');
            } else {
                throw new Error('填充答案失败');
            }
        } catch (error) {
            console.error('AI答题失败:', error);
        } finally {
            delete subjectItem.dataset.aiBusy;
        }
    }

    // 为单个题目添加点击答题
    function addClickToAnswer(subjectItem) {
        const itemBody = subjectItem.querySelector('.item-body');
        if (!itemBody) return;

        // 找到 .clearfix.exam-font 题目文字区域
        const examFont = itemBody.querySelector('.clearfix.exam-font');
        if (!examFont) return;

        // 检查是否已添加
        if (examFont.dataset.aiClickEnabled === 'true') return;
        examFont.dataset.aiClickEnabled = 'true';

        const questionType = detectQuestionType(subjectItem);
        const typeLabel = questionType === QUESTION_TYPES.SINGLE_CHOICE ? '单选' :
            questionType === QUESTION_TYPES.MULTI_CHOICE ? '多选' :
            questionType === QUESTION_TYPES.FILL_BLANK ? '填空' :
            questionType === QUESTION_TYPES.SUBJECTIVE ? '主观' : '未知';

        // 添加可答标记类名（cursor: pointer）
        examFont.classList.add('ai-answerable');
        examFont.title = `点击AI答题 (${typeLabel})`;

        // 点击题目文字区域 → 自动答题
        examFont.addEventListener('click', async function(e) {
            // 不拦截填空输入框、编辑器等已有交互
            if (e.target.closest('input, textarea, .ueditor-content, [contenteditable="true"]')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            await triggerAnswerForSubject(subjectItem);
        });

        console.log(`🎯 已绑定: ${typeLabel} | ${examFont.textContent.trim().substring(0, 40)}...`);
    }

    // 扫描并添加点击答题
    function scanAndAddButtons() {
        const subjectItems = document.querySelectorAll('.subject-item');
        subjectItems.forEach(subjectItem => {
            const itemBody = subjectItem.querySelector('.item-body');
            if (itemBody) {
                addClickToAnswer(subjectItem);
            }
        });
    }

    // 初始化
    function init() {
        scanAndAddButtons();

        // 监听DOM变化
        const observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    shouldScan = true;
                    break;
                }
            }
            if (shouldScan) {
                scanAndAddButtons();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 定期扫描
        setInterval(scanAndAddButtons, 3000);

        console.log('考试题目自动提取脚本 v2.5 已加载 - 悬浮 .clearfix.exam-font 出现手指光标，点击自动AI答题');
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
