// score_editor.js
// Assumes VexFlow and Tone.js are included via script tags

const scoreEditor = {
    init: function(options) {
        this.options = {
            containerId: 'output',
            enableAssessment: false,
            enableVoiceSelection: false,
            ...options // Allow overriding default options
        };

        this.state = {
            scoreData: {
                measures: [{ notes: [], timeSignature: "4/4" }],
                keySig: "C",
                tempo: 120
            },
            currentTool: 'add',
            currentDuration: 'q',
            currentAccidental: '',
            selectedNoteInfo: null,
            isDragging: false,
            startY: null,
            currentScale: 1.0,
            renderedStaves: [],
            renderedVexNotes: [],
            player: null, // Tone.js player instance
            ppq: 480, // Default PPQ (adjust if needed)
            activeVoices: ['all'], // Array to hold active voice ids or 'all'
            assessmentData: [],
            assessmentRunning: false,
            assessmentStartTime: 0,
            playing: false,
            synths: [],
            noteHighlightTimeouts: []
        };

        this.cacheDOM();
        this.bindEvents();
        this.initVexFlow();
        this.renderScore();
        this.setupPlayback();
        if (this.options.enableAssessment) {
            this.setupAssessment();
        }
        if (this.options.enableVoiceSelection) {
            this.setupVoiceControls();
        }
    },

    cacheDOM: function() {
        this.container = document.getElementById(this.options.containerId);
        this.toolContainer = document.querySelector('.editor-tools');
        this.durationContainer = document.querySelector('.editor-tools');
        this.accidentalContainer = document.querySelector('.editor-tools');
        this.addMeasureBtn = document.getElementById('add-measure');
        this.clearScoreBtn = document.getElementById('clear-score');
        this.exportMidiBtn = document.getElementById('export-midi');
        this.saveExerciseBtn = document.getElementById('save-exercise');
        this.playBtn = document.getElementById('play-btn');
        this.pauseBtn = document.getElementById('pause-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.tempoSlider = document.getElementById('tempo-slider');
        this.tempoValue = document.getElementById('tempo-value');
        this.assessmentModeSwitch = document.getElementById('assessment-mode');
        this.assessmentControls = document.getElementById('assessment-controls');
        this.startAssessmentBtn = document.getElementById('start-assessment');
        this.assessmentResults = document.getElementById('assessment-results');
        this.pitchAccuracyBar = document.getElementById('pitch-accuracy');
        this.accuracyValue = document.getElementById('accuracy-value');
        this.voiceControls = document.querySelector('.voice-controls');
    },

    bindEvents: function() {
        // Tool and duration selection using event delegation
        if (this.toolContainer) {
            this.toolContainer.addEventListener('click', this.handleToolClick.bind(this));
        }
        if (this.durationContainer) {
            this.durationContainer.addEventListener('click', this.handleDurationClick.bind(this));
        }
        if (this.accidentalContainer) {
            this.accidentalContainer.addEventListener('click', this.handleAccidentalClick.bind(this));
        }

        if (this.addMeasureBtn) {
            this.addMeasureBtn.addEventListener('click', this.addMeasure.bind(this));
        }
        if (this.clearScoreBtn) {
            this.clearScoreBtn.addEventListener('click', this.clearScore.bind(this));
        }
        if (this.exportMidiBtn) {
            this.exportMidiBtn.addEventListener('click', this.exportToMidi.bind(this));
        }
        if (this.saveExerciseBtn) {
            this.saveExerciseBtn.addEventListener('click', this.saveExercise.bind(this));
        }

        if (this.playBtn) {
            this.playBtn.addEventListener('click', this.play.bind(this));
        }
        if (this.pauseBtn) {
            this.pauseBtn.addEventListener('click', this.pause.bind(this));
        }
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', this.stop.bind(this));
        }
        if (this.tempoSlider) {
            this.tempoSlider.addEventListener('input', this.adjustTempo.bind(this));
        }

        if (this.assessmentModeSwitch) {
            this.assessmentModeSwitch.addEventListener('change', this.toggleAssessmentMode.bind(this));
        }
        if (this.startAssessmentBtn) {
            this.startAssessmentBtn.addEventListener('click', this.startAssessment.bind(this));
        }
        if (this.voiceControls) {
            this.voiceControls.addEventListener('change', this.handleVoiceChange.bind(this));
        }

        // Add keyboard event listener for editing notes
        document.addEventListener('keydown', this.handleKeyboardControl.bind(this));
    },

    initVexFlow: function() {
        this.VF = Vex.Flow;
    },

    /*
     * TOOL AND DURATION HANDLERS
     */
    handleToolClick: function(event) {
        const tool = event.target.closest('[id^="tool-"]');
        if (tool) {
            this.setTool(tool.id.split('-')[1]);
        }
    },

    handleDurationClick: function(event) {
        const duration = event.target.closest('[id^="duration-"]');
        if (duration) {
            this.setDuration(duration.id.split('-')[1]);
        }
    },

    handleAccidentalClick: function(event) {
        const accidental = event.target.closest('[id^="accidental-"]');
        if (accidental) {
            let acc = accidental.id.split('-')[1];
            if (acc === 'flat') acc = 'b';
            if (acc === 'sharp') acc = '#';
            if (acc === 'natural') acc = 'n';
            this.setAccidental(acc);
        }
    },

    setTool: function(tool) {
        this.state.currentTool = tool;
        document.querySelectorAll('#tool-add, #tool-edit, #tool-delete').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`tool-${tool}`).classList.add('active');
        this.clearNoteHighlights();
        this.state.selectedNoteInfo = null;
    },

    setDuration: function(duration) {
        this.state.currentDuration = duration;
        document.querySelectorAll('[id^="duration-"]').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`duration-${duration}`).classList.add('active');
    },

    setAccidental: function(accidental) {
        this.state.currentAccidental = accidental;
        document.querySelectorAll('[id^="accidental-"]').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`accidental-${accidental === 'b' ? 'flat' : accidental === '#' ? 'sharp' : 'natural'}`).classList.add('active');
    },

    /*
     * NOTE MANIPULATION
     */
    yToNote: function(y, stave) {
        const staveTop = stave.getYForLine(0);
        const lineHeight = stave.getYForLine(1) - staveTop;
        const relativeY = y - staveTop;
        const position = Math.round(relativeY / (lineHeight / 2));
        const baseNotes = ['f/5', 'e/5', 'd/5', 'c/5', 'b/4', 'a/4', 'g/4', 'f/4', 'e/4', 'd/4', 'c/4', 'b/3', 'a/3', 'g/3', 'f/3'];
        const index = Math.max(0, Math.min(position, baseNotes.length - 1));
        return baseNotes[index];
    },

    createNoteData: function(key, duration, accidental = null) {
        const [noteName, octave] = key.split('/');
        const noteToMidi = {
            'c': 0,
            'c#': 1,
            'db': 1,
            'd': 2,
            'd#': 3,
            'eb': 3,
            'e': 4,
            'f': 5,
            'f#': 6,
            'gb': 6,
            'g': 7,
            'g#': 8,
            'ab': 8,
            'a': 9,
            'a#': 10,
            'bb': 10,
            'b': 11
        };
        let midiNote = (parseInt(octave) + 1) * 12;
        midiNote += noteToMidi[noteName.toLowerCase()];
        if (accidental === '#') midiNote += 1;
        if (accidental === 'b') midiNote -= 1;
        const durationTicks = {
            'w': this.state.ppq * 4,
            'h': this.state.ppq * 2,
            'q': this.state.ppq,
            '8': this.state.ppq / 2,
            '16': this.state.ppq / 4
        }[duration];
        return {
            key: key,
            duration: duration,
            accidental: accidental,
            midiNote: midiNote,
            ticks: 0,
            durationTicks: durationTicks
        };
    },

    addNote: function(measureIndex, key, duration, accidental = null) {
        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length) {
            console.error('Invalid measure index:', measureIndex);
            return;
        }
        const noteData = this.createNoteData(key, duration, accidental);
        this.state.scoreData.measures[measureIndex].notes.push(noteData);
        this.updateNotePositions();
        this.renderScore();
    },

    addNoteAtPosition: function(measureIndex, key, duration, accidental, tickPosition) {
        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length) {
            console.error('Invalid measure index:', measureIndex);
            return;
        }
        const noteData = this.createNoteData(key, duration, accidental);
        noteData.ticks = tickPosition;
        this.state.scoreData.measures[measureIndex].notes.push(noteData);
        this.updateNotePositions();
        this.renderScore();
    },

    editNote: function(measureIndex, noteIndex, newKey, newDuration, newAccidental) {
        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length ||
            noteIndex < 0 || noteIndex >= this.state.scoreData.measures[measureIndex].notes.length) {
            console.error('Invalid note index:', measureIndex, noteIndex);
            return;
        }

        const noteData = this.createNoteData(newKey, newDuration || this.state.scoreData.measures[measureIndex].notes[noteIndex].duration, 
                                           newAccidental !== undefined ? newAccidental : this.state.scoreData.measures[measureIndex].notes[noteIndex].accidental);

        this.state.scoreData.measures[measureIndex].notes[noteIndex] = {
            ...this.state.scoreData.measures[measureIndex].notes[noteIndex],
            key: noteData.key,
            duration: noteData.duration,
            accidental: noteData.accidental,
            midiNote: noteData.midiNote,
            durationTicks: noteData.durationTicks
        };
        
        this.updateNotePositions();
        this.renderScore();
        if (this.state.selectedNoteInfo) {
            this.highlightNote(measureIndex, noteIndex);
        }
    },

    deleteNote: function(measureIndex, noteIndex) {
        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length ||
            noteIndex < 0 || noteIndex >= this.state.scoreData.measures[measureIndex].notes.length) {
            console.error('Invalid note index:', measureIndex, noteIndex);
            return;
        }
        this.state.scoreData.measures[measureIndex].notes.splice(noteIndex, 1);
        this.updateNotePositions();
        this.renderScore();
        this.state.selectedNoteInfo = null;
    },

    /*
     * SCORE MANIPULATION
     */
    addMeasure: function() {
        this.state.scoreData.measures.push({
            notes: [],
            timeSignature: this.state.scoreData.measures[0].timeSignature
        });
        this.renderScore();
    },

    clearScore: function() {
        if (confirm('Are you sure you want to clear the entire score?')) {
            this.state.scoreData.measures = [{
                notes: [],
                timeSignature: "4/4"
            }];
            this.renderScore();
        }
    },

    /*
     * NOTE POSITION UPDATES
     */
    updateNotePositions: function() {
        this.state.scoreData.measures.forEach(measure => {
            measure.notes.sort((a, b) => a.ticks - b.ticks);
            let currentTick = 0;
            measure.notes.forEach(note => {
                note.ticks = currentTick;
                currentTick += note.durationTicks;
            });
        });
    },

    /*
     * RENDERING
     */
    renderScore: function() {
        this.container.innerHTML = '';
        const renderer = new this.VF.Renderer(this.container, this.VF.Renderer.Backends.SVG);
        const width = Math.max(500, this.state.scoreData.measures.length * 300);
        const height = 200;
        renderer.resize(width * this.state.currentScale, height * this.state.currentScale);
        const context = renderer.getContext();
        context.scale(this.state.currentScale, this.state.currentScale);
        this.state.renderedStaves = [];
        this.state.renderedVexNotes = []; // This will be a 2D array

        this.state.scoreData.measures.forEach((measure, measureIndex) => {
            const stave = new this.VF.Stave(
                10 + measureIndex * 290,
                40,
                290
            );

            if (measureIndex === 0) {
                stave.addClef("treble").addTimeSignature(measure.timeSignature);
            }

            stave.setContext(context).draw();
            this.state.renderedStaves.push(stave);

            const vexNotes = measure.notes.map((note, index) => {
                const staveNote = new this.VF.StaveNote({
                    keys: [note.key],
                    duration: note.duration
                });

                if (note.accidental) {
                    staveNote.addModifier(new this.VF.Accidental(note.accidental), 0);
                }

                return staveNote;
            });

            this.state.renderedVexNotes.push(vexNotes);

            const beams = this.VF.Beam.generateBeams(vexNotes.filter(note =>
                note.getDuration() === "8" || note.getDuration() === "16"
            ));

            if (vexNotes.length > 0) {
                this.VF.Formatter.FormatAndDraw(context, stave, vexNotes);
                beams.forEach(beam => {
                    beam.setContext(context).draw();
                });
            }
        });

        this.setupNoteInteraction();
    },

    setupNoteInteraction: function() {
        const output = this.container;

        // Remove previous event listeners if any
        const newOutput = output.cloneNode(true);
        output.parentNode.replaceChild(newOutput, output);
        this.container = newOutput;

        this.container.addEventListener('click', (e) => {
            const svgElement = e.target.closest('svg');
            if (!svgElement) return;

            const rect = svgElement.getBoundingClientRect();
            const x = (e.clientX - rect.left) / this.state.currentScale;
            const y = (e.clientY - rect.top) / this.state.currentScale;

            let clickedStave = null;
            let clickedMeasureIndex = -1;

            this.state.renderedStaves.forEach((stave, index) => {
                const staveX = stave.getX();
                const staveY = stave.getY();
                const staveWidth = stave.getWidth();
                const staveHeight = 100; // Approximate height

                if (x >= staveX && x <= staveX + staveWidth &&
                    y >= staveY && y <= staveY + staveHeight) {
                    clickedStave = stave;
                    clickedMeasureIndex = index;
                    return; // Exit the loop once the stave is found
                }
            });

            if (clickedStave) {
                this.handleStaveClick(e, clickedStave, clickedMeasureIndex);
            }
        });
    },

    handleStaveClick: function(e, stave, measureIndex) {
        const svgElement = e.target.closest('svg');
        if (!svgElement) return;

        const rect = svgElement.getBoundingClientRect();
        const x = (e.clientX - rect.left) / this.state.currentScale;
        const y = (e.clientY - rect.top) / this.state.currentScale;

        if (measureIndex >= 0 && measureIndex < this.state.renderedVexNotes.length && this.state.renderedVexNotes[measureIndex]) {
            const vexNotesInMeasure = this.state.renderedVexNotes[measureIndex];

            for (let i = 0; i < vexNotesInMeasure.length; i++) {
                const vexNote = vexNotesInMeasure[i];
                const boundingBox = vexNote.getBoundingBox();

                // Check if the click coordinates are within the note's bounding box
                if (x >= boundingBox.x && x <= boundingBox.x + boundingBox.w &&
                    y >= boundingBox.y && y <= boundingBox.y + boundingBox.h) {

                    console.log('Clicked on note at measure:', measureIndex, 'index:', i);

                    if (this.state.currentTool === 'edit') {
                        this.state.selectedNoteInfo = {
                            measureIndex: measureIndex,
                            noteIndex: i
                        };
                        this.highlightNote(measureIndex, i);
                    } else if (this.state.currentTool === 'delete') {
                        this.deleteNote(measureIndex, i);
                    }
                    return; // Found the note, exit
                }
            }
        }

        // If not in edit or delete mode, handle adding a new note
        if (this.state.currentTool === 'add') {
            const noteKey = this.yToNote(y, stave);
            const measure = this.state.scoreData.measures[measureIndex];
            let newPosition = 0;
            if (measure.notes.length > 0) {
                const lastNote = measure.notes[measure.notes.length - 1];
                newPosition = lastNote.ticks + lastNote.durationTicks;
            }
            const measureDuration = this.state.ppq * 4; // 4/4 time signature = 4 beats = 4 * PPQ ticks
            if (newPosition + this.getDurationTicks(this.state.currentDuration) > measureDuration) {
                console.log('Cannot add note: would exceed measure length');
                return;
            }
            this.addNoteAtPosition(measureIndex, noteKey, this.state.currentDuration, this.state.currentAccidental, newPosition);
        }
    },

    getDurationTicks: function(duration) {
        const durationMapping = {
            'w': this.state.ppq * 4,
            'h': this.state.ppq * 2,
            'q': this.state.ppq,
            '8': this.state.ppq / 2,
            '16': this.state.ppq / 4
        };
        return durationMapping[duration] || this.state.ppq;
    },

    highlightNote: function(measureIndex, noteIndex) {
        console.log('Highlighting note at measure:', measureIndex, 'index:', noteIndex);
        this.clearNoteHighlights();

        const vfContainer = document.querySelector('#' + this.options.containerId + ' svg');
        if (!vfContainer) {
            console.log('SVG container not found for highlighting.');
            return;
        }

        // Try to find the note element in the rendered SVG
        if (this.state.renderedVexNotes[measureIndex] && this.state.renderedVexNotes[measureIndex][noteIndex]) {
            const allNotes = vfContainer.querySelectorAll('.vf-stavenote');
            let currentIndex = 0;
            
            for (let m = 0; m <= measureIndex; m++) {
                if (this.state.renderedVexNotes[m]) {
                    for (let n = 0; n < this.state.renderedVexNotes[m].length; n++) {
                        if (m === measureIndex && n === noteIndex) {
                            const targetNoteElement = allNotes[currentIndex];
                            if (targetNoteElement) {
                                const noteheadPaths = targetNoteElement.querySelectorAll('.vf-notehead > path');
                                noteheadPaths.forEach(path => {
                                    if (!path.getAttribute('data-original-fill')) {
                                        path.setAttribute('data-original-fill', path.getAttribute('fill') || 'black');
                                        path.setAttribute('data-original-stroke', path.getAttribute('stroke') || 'none');
                                    }
                                    path.setAttribute('fill', '#ff5722');
                                    path.setAttribute('stroke', '#ff5722');
                                    path.setAttribute('data-highlighted', 'true');
                                });
                                
                                const stemPath = targetNoteElement.querySelector('.vf-stem > path');
                                if (stemPath) {
                                    if (!stemPath.getAttribute('data-original-fill')) {
                                        stemPath.setAttribute('data-original-fill', stemPath.getAttribute('fill') || 'black');
                                    }
                                    stemPath.setAttribute('fill', '#ff5722');
                                    stemPath.setAttribute('data-highlighted', 'true');
                                }
                            }
                            return;
                        }
                        currentIndex++;
                    }
                }
            }
        }
    },

    clearNoteHighlights: function() {
        console.log('Clearing note highlights');
        const vfContainer = document.querySelector('#' + this.options.containerId + ' svg');
        if (!vfContainer) return;

        const highlightedNoteheads = vfContainer.querySelectorAll('.vf-notehead > path[data-highlighted="true"]');
        highlightedNoteheads.forEach(path => {
            path.setAttribute('fill', path.getAttribute('data-original-fill') || 'black');
            path.setAttribute('stroke', path.getAttribute('data-original-stroke') || 'none');
            path.removeAttribute('data-original-fill');
            path.removeAttribute('data-original-stroke');
            path.removeAttribute('data-highlighted');
        });

        const highlightedStems = vfContainer.querySelectorAll('.vf-stem > path[data-highlighted="true"]');
        highlightedStems.forEach(path => {
            path.setAttribute('fill', path.getAttribute('data-original-fill') || 'black');
            path.removeAttribute('data-original-fill');
            path.removeAttribute('data-highlighted');
        });
    },

    handleKeyboardControl: function(e) {
        if (!this.state.selectedNoteInfo) return;

        const { measureIndex, noteIndex } = this.state.selectedNoteInfo;

        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length ||
            noteIndex < 0 || noteIndex >= this.state.scoreData.measures[measureIndex].notes.length) {
            this.state.selectedNoteInfo = null;
            return;
        }

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                this.moveSelectedNoteVertically(-1);
                break;

            case 'ArrowDown':
                e.preventDefault();
                this.moveSelectedNoteVertically(1);
                break;

            case 'ArrowLeft':
                e.preventDefault();
                this.changeNoteAccidental(-1);
                break;

            case 'ArrowRight':
                e.preventDefault();
                this.changeNoteAccidental(1);
                break;

            case 'Delete':
            case 'Backspace':
                e.preventDefault();
                this.deleteNote(this.state.selectedNoteInfo.measureIndex, this.state.selectedNoteInfo.noteIndex);
                this.state.selectedNoteInfo = null;
                break;
        }
    },

    moveSelectedNoteVertically: function(direction) {
        if (!this.state.selectedNoteInfo) return;

        const { measureIndex, noteIndex } = this.state.selectedNoteInfo;

        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length ||
            noteIndex < 0 || noteIndex >= this.state.scoreData.measures[measureIndex].notes.length) {
            this.state.selectedNoteInfo = null;
            return;
        }

        const note = this.state.scoreData.measures[measureIndex].notes[noteIndex];
        const [noteNameWithAccidental, octaveStr] = note.key.split('/');
        const noteBaseName = noteNameWithAccidental.replace(/[#b]/, '');
        const accidental = noteNameWithAccidental.includes('#') ? '#' : noteNameWithAccidental.includes('b') ? 'b' : '';
        let currentOctave = parseInt(octaveStr);
        const scale = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
        let noteIndexInScale = scale.indexOf(noteBaseName.toLowerCase());

        noteIndexInScale += direction;

        if (direction === -1 && noteIndexInScale < 0) {
            noteIndexInScale = scale.length - 1;
            currentOctave--;
        } else if (direction === 1 && noteIndexInScale >= scale.length) {
            noteIndexInScale = 0;
            currentOctave++;
        } else if (noteIndexInScale < 0) {
            noteIndexInScale = 0; // Prevent going below C3
            currentOctave = Math.max(3, currentOctave);
        } else if (noteIndexInScale >= scale.length) {
            noteIndexInScale = scale.length - 1; // Prevent going above B6
            currentOctave = Math.min(6, currentOctave);
        }

        currentOctave = Math.max(3, Math.min(currentOctave, 6)); // Ensure octave stays within a reasonable range
        const newKey = `${scale[noteIndexInScale]}${accidental}/${currentOctave}`;
        note.key = newKey;

        const noteToMidiBase = {
            'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11
        };
        let midiNote = (currentOctave + 1) * 12 + noteToMidiBase[scale[noteIndexInScale]];
        if (accidental === '#') midiNote += 1;
        if (accidental === 'b') midiNote -= 1;
        note.midiNote = midiNote;

        this.renderScore();
        this.highlightNote(measureIndex, noteIndex);
    },

    changeNoteAccidental: function(direction) {
        if (!this.state.selectedNoteInfo) return;

        const { measureIndex, noteIndex } = this.state.selectedNoteInfo;

        if (measureIndex < 0 || measureIndex >= this.state.scoreData.measures.length ||
            noteIndex < 0 || noteIndex >= this.state.scoreData.measures[measureIndex].notes.length) {
            this.state.selectedNoteInfo = null;
            return;
        }

        const note = this.state.scoreData.measures[measureIndex].notes[noteIndex];
        const accidentals = ['b', '', '#'];
        let currentIndex = accidentals.indexOf(note.accidental || '');
        currentIndex = (currentIndex + direction + accidentals.length) % accidentals.length;
        note.accidental = accidentals[currentIndex];

        const [noteName, octave] = note.key.split('/');
        const noteBaseName = noteName.replace(/[#b]/, '');
        const noteToMidiBase = {
            'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11
        };
        let midiNote = (parseInt(octave) + 1) * 12 + noteToMidiBase[noteBaseName.toLowerCase()];
        if (note.accidental === '#') midiNote += 1;
        if (note.accidental === 'b') midiNote -= 1;
        note.midiNote = midiNote;

        this.renderScore();
        this.highlightNote(measureIndex, noteIndex);
    },

    /* 
     * PLAYBACK FUNCTIONS
     */
    setupPlayback: function() {
        if (this.tempoValue) {
            this.tempoValue.textContent = `${this.state.scoreData.tempo} BPM`;
        }
        if (this.tempoSlider) {
            this.tempoSlider.value = this.state.scoreData.tempo;
        }
    },

    play: function() {
        if (this.state.playing) return;

        const now = Tone.now() + 0.1;

        while (this.state.synths.length) {
            const synth = this.state.synths.shift();
            synth.disconnect();
        }
        this.state.noteHighlightTimeouts.forEach(timeout => clearTimeout(timeout));
        this.state.noteHighlightTimeouts = [];
        this.clearNoteHighlights();

        const synth = new Tone.PolySynth(Tone.Synth, {
            envelope: {
                attack: 0.02,
                decay: 0.1,
                sustain: 0.3,
                release: 1,
            }
        }).toDestination();
        this.state.synths.push(synth);

        // Calculate measures and beat durations
        const secondsPerBeat = 60 / this.state.scoreData.tempo;
        let totalOffset = 0;

        this.state.scoreData.measures.forEach((measure, measureIndex) => {
            measure.notes.forEach((note, noteIndex) => {
                const beat = note.ticks / this.state.ppq;
                const playTime = now + totalOffset + (beat * secondsPerBeat);
                
                // Only play active voices
                if (this.state.activeVoices.includes('all') || 
                    (note.voice && this.state.activeVoices.includes(note.voice))) {
                    
                    // Convert MIDI note to frequency
                    const freq = Tone.Frequency(note.midiNote, "midi").toFrequency();
                    
                    // Calculate duration in seconds
                    const durationInBeats = note.durationTicks / this.state.ppq;
                    const durationInSeconds = durationInBeats * secondsPerBeat;
                    
                    // Play the note
                    synth.triggerAttackRelease(freq, durationInSeconds, playTime);
                    
                    // Set up highlighting
                    const timeout = setTimeout(() => {
                        this.highlightNote(measureIndex, noteIndex);
                        setTimeout(() => {
                            this.clearNoteHighlights();
                        }, durationInSeconds * 1000);
                    }, (playTime - now) * 1000);
                    
                    this.state.noteHighlightTimeouts.push(timeout);
                }
            });
            
            // Add measure duration to total offset
            totalOffset += 4 * secondsPerBeat; // 4/4 time for now
        });

        this.state.playing = true;
        
        // Set timeout to stop playing when finished
        setTimeout(() => {
            this.state.playing = false;
            this.clearNoteHighlights();
        }, totalOffset * 1000);
    },

    pause: function() {
        if (!this.state.playing) return;
        Tone.Transport.pause();
        this.state.playing = false;
    },

    stop: function() {
        Tone.Transport.stop();
        this.state.playing = false;
        this.state.noteHighlightTimeouts.forEach(timeout => clearTimeout(timeout));
        this.state.noteHighlightTimeouts = [];
        this.clearNoteHighlights();
    },

    adjustTempo: function(e) {
        const newTempo = parseInt(e.target.value);
        this.state.scoreData.tempo = newTempo;
        if (this.tempoValue) {
            this.tempoValue.textContent = `${newTempo} BPM`;
        }
    },

    /*
     * ASSESSMENT FUNCTIONS
     */
    setupAssessment: function() {
        if (this.assessmentControls) {
            this.assessmentControls.style.display = 'none';
        }
    },

    toggleAssessmentMode: function(e) {
        const enabled = e.target.checked;
        if (this.assessmentControls) {
            this.assessmentControls.style.display = enabled ? 'block' : 'none';
        }
    },

    startAssessment: function() {
        if (this.state.assessmentRunning) return;

        this.state.assessmentRunning = true;
        this.state.assessmentStartTime = Date.now();
        this.state.assessmentData = [];
        
        // Start audio context if not already running
        Tone.start();
        
        // Use the Web Audio API to access microphone
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const microphone = audioContext.createMediaStreamSource(stream);
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 2048;
                microphone.connect(analyser);
                
                const bufferLength = analyser.frequencyBinCount;
                const dataArray = new Float32Array(bufferLength);
                
                const detectPitch = () => {
                    if (!this.state.assessmentRunning) {
                        stream.getTracks().forEach(track => track.stop());
                        return;
                    }
                    
                    // Get frequency data
                    analyser.getFloatTimeDomainData(dataArray);
                    
                    // Basic pitch detection using autocorrelation
                    const pitch = this.detectPitchAutocorrelation(dataArray, audioContext.sampleRate);
                    
                    if (pitch > 0) {
                        // Convert frequency to MIDI note
                        const midiNote = Math.round(12 * Math.log2(pitch / 440) + 69);
                        this.state.assessmentData.push({
                            time: Date.now() - this.state.assessmentStartTime,
                            detectedFreq: pitch,
                            detectedNote: midiNote
                        });
                    }
                    
                    requestAnimationFrame(detectPitch);
                };
                
                detectPitch();
                
                // Play score for reference
                this.play();
                
                // Stop assessment after playback ends
                const totalDuration = this.calculateTotalDuration();
                setTimeout(() => {
                    this.stopAssessment();
                }, totalDuration * 1000);
            })
            .catch(error => {
                console.error('Error accessing microphone:', error);
                this.state.assessmentRunning = false;
                alert('Could not access microphone. Please check permissions.');
            });
    },

    stopAssessment: function() {
        this.state.assessmentRunning = false;
        
        // Calculate assessment score
        const score = this.calculateAssessmentScore();
        
        // Display results
        if (this.pitchAccuracyBar) {
            this.pitchAccuracyBar.style.width = `${score.pitchAccuracy}%`;
        }
        if (this.accuracyValue) {
            this.accuracyValue.textContent = `${score.pitchAccuracy.toFixed(1)}%`;
        }
        if (this.assessmentResults) {
            this.assessmentResults.style.display = 'block';
        }
    },

    calculateAssessmentScore: function() {
        // Simple scoring based on pitch accuracy
        let correctPitches = 0;
        let totalNotes = 0;
        
        this.state.scoreData.measures.forEach(measure => {
            totalNotes += measure.notes.length;
        });
        
        this.state.assessmentData.forEach(data => {
            // Find the expected note at this time point
            const expectedNote = this.findExpectedNote(data.time);
            
            if (expectedNote && data.detectedNote === expectedNote.midiNote) {
                correctPitches++;
            }
        });
        
        const pitchAccuracy = totalNotes > 0 ? (correctPitches / totalNotes) * 100 : 0;
        
        return {
            pitchAccuracy: pitchAccuracy,
            correctPitches: correctPitches,
            totalNotes: totalNotes
        };
    },

    findExpectedNote: function(timeMs) {
        // Convert time in ms to time in beats
        const timeSec = timeMs / 1000;
        const secondsPerBeat = 60 / this.state.scoreData.tempo;
        const currentBeat = timeSec / secondsPerBeat;
        
        // Find the note that should be playing at this time
        let cumulativeBeat = 0;
        
        for (let i = 0; i < this.state.scoreData.measures.length; i++) {
            const measure = this.state.scoreData.measures[i];
            
            for (let j = 0; j < measure.notes.length; j++) {
                const note = measure.notes[j];
                const noteBeat = note.ticks / this.state.ppq;
                const noteDuration = note.durationTicks / this.state.ppq;
                
                if (currentBeat >= cumulativeBeat + noteBeat && 
                    currentBeat < cumulativeBeat + noteBeat + noteDuration) {
                    return note;
                }
            }
            
            // Add measure duration to cumulative beat
            cumulativeBeat += 4; // 4 beats per measure for 4/4 time
        }
        
        return null;
    },

    detectPitchAutocorrelation: function(buffer, sampleRate) {
        // Basic autocorrelation pitch detection
        const SIZE = buffer.length;
        const MAX_SAMPLES = Math.floor(SIZE/2);
        let bestOffset = -1;
        let bestCorrelation = 0;
        let rms = 0;
        
        // Calculate RMS to determine if there's enough signal
        for (let i = 0; i < SIZE; i++) {
            rms += buffer[i] * buffer[i];
        }
        rms = Math.sqrt(rms / SIZE);
        
        if (rms < 0.01) {
            return -1; // Not enough signal
        }
        
        // Find the peak of the autocorrelation function
        for (let offset = 2; offset < MAX_SAMPLES; offset++) {
            let correlation = 0;
            
            for (let i = 0; i < MAX_SAMPLES; i++) {
                correlation += Math.abs(buffer[i] - buffer[i + offset]);
            }
            
            correlation = 1 - (correlation / MAX_SAMPLES);
            
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = offset;
            }
        }
        
        if (bestCorrelation > 0.5) {
            return sampleRate / bestOffset;
        }
        
        return -1;
    },

    calculateTotalDuration: function() {
        // Calculate total duration of the score in seconds
        const secondsPerBeat = 60 / this.state.scoreData.tempo;
        return this.state.scoreData.measures.length * 4 * secondsPerBeat; // 4 beats per measure for 4/4 time
    },

    /*
     * VOICE SELECTION FUNCTIONS
     */
    setupVoiceControls: function() {
        if (this.voiceControls) {
            this.voiceControls.style.display = this.options.enableVoiceSelection ? 'block' : 'none';
            this.renderVoiceCheckboxes();
        }
    },

    renderVoiceCheckboxes: function() {
        if (!this.voiceControls) return;
        
        // Clear existing checkboxes
        this.voiceControls.innerHTML = '';
        
        // Add "All Voices" checkbox
        const allVoicesLabel = document.createElement('label');
        allVoicesLabel.className = 'voice-checkbox';
        
        const allVoicesCheckbox = document.createElement('input');
        allVoicesCheckbox.type = 'checkbox';
        allVoicesCheckbox.name = 'voice-all';
        allVoicesCheckbox.checked = this.state.activeVoices.includes('all');
        allVoicesCheckbox.value = 'all';
        
        allVoicesLabel.appendChild(allVoicesCheckbox);
        allVoicesLabel.appendChild(document.createTextNode(' All Voices'));
        this.voiceControls.appendChild(allVoicesLabel);
        
        // Add individual voice checkboxes
        const voices = this.getAvailableVoices();
        voices.forEach(voice => {
            const voiceLabel = document.createElement('label');
            voiceLabel.className = 'voice-checkbox';
            
            const voiceCheckbox = document.createElement('input');
            voiceCheckbox.type = 'checkbox';
            voiceCheckbox.name = `voice-${voice}`;
            voiceCheckbox.checked = this.state.activeVoices.includes(voice);
            voiceCheckbox.value = voice;
            
            voiceLabel.appendChild(voiceCheckbox);
            voiceLabel.appendChild(document.createTextNode(` Voice ${voice}`));
            this.voiceControls.appendChild(voiceLabel);
        });
    },

    getAvailableVoices: function() {
        // Extract unique voice IDs from score data
        const voices = new Set();
        this.state.scoreData.measures.forEach(measure => {
            measure.notes.forEach(note => {
                if (note.voice) {
                    voices.add(note.voice);
                }
            });
        });
        return Array.from(voices);
    },

    handleVoiceChange: function(e) {
        const checkbox = e.target;
        if (!checkbox || checkbox.type !== 'checkbox') return;
        
        const voiceId = checkbox.value;
        
        if (voiceId === 'all') {
            // Handle "All Voices" checkbox
            if (checkbox.checked) {
                this.state.activeVoices = ['all'];
                // Check the "All" checkbox and uncheck others
                document.querySelectorAll('.voice-checkbox input').forEach(cb => {
                    cb.checked = cb.value === 'all';
                });
            } else {
                this.state.activeVoices = [];
            }
        } else {
            // Handle individual voice checkbox
            if (checkbox.checked) {
                // Remove 'all' if it exists
                this.state.activeVoices = this.state.activeVoices.filter(v => v !== 'all');
                // Add this voice
                this.state.activeVoices.push(voiceId);
                // Uncheck "All Voices"
                const allCheckbox = document.querySelector('input[name="voice-all"]');
                if (allCheckbox) {
                    allCheckbox.checked = false;
                }
            } else {
                // Remove this voice
                this.state.activeVoices = this.state.activeVoices.filter(v => v !== voiceId);
            }
        }
    },

    /*
     * EXPORT FUNCTIONS
     */
    exportToMidi: function() {
        console.log("Exporting to MIDI...");
        
        // Create a new MIDI file
        const midi = {
            header: {
                format: 1,
                numTracks: 1,
                ticksPerBeat: this.state.ppq
            },
            tracks: [[
                {
                    deltaTime: 0,
                    type: 'trackName',
                    text: 'Score Editor Export'
                },
                {
                    deltaTime: 0,
                    type: 'setTempo',
                    microsecondsPerBeat: Math.round(60000000 / this.state.scoreData.tempo)
                }
            ]]
        };
        
        // Add time signature
        const timeSignature = this.state.scoreData.measures[0].timeSignature;
        const [numerator, denominator] = timeSignature.split('/').map(Number);
        midi.tracks[0].push({
            deltaTime: 0,
            type: 'timeSignature',
            numerator: numerator,
            denominator: denominator,
            metronome: 24,
            thirtyseconds: 8
        });
        
        // Add notes to track
        let currentTick = 0;
        
        this.state.scoreData.measures.forEach(measure => {
            measure.notes.forEach(note => {
                // Add note on event
                midi.tracks[0].push({
                    deltaTime: note.ticks - currentTick,
                    type: 'noteOn',
                    noteNumber: note.midiNote,
                    velocity: 80,
                    channel: 0
                });
                
                currentTick = note.ticks;
                
                // Add note off event
                midi.tracks[0].push({
                    deltaTime: note.durationTicks,
                    type: 'noteOff',
                    noteNumber: note.midiNote,
                    velocity: 0,
                    channel: 0
                });
                
                currentTick += note.durationTicks;
            });
        });
        
        // Add end of track event
        midi.tracks[0].push({
            deltaTime: 0,
            type: 'endOfTrack'
        });
        
        // Use external library to convert midi object to binary data
        // For this to work, you'd need to include a library like midi-writer-js
        // This is a placeholder for that functionality
        alert('MIDI export functionality requires an external MIDI library. Please implement with midi-writer-js or similar.');
        
        // Example of how it would work with midi-writer-js:
        // const writer = new MidiWriter.Writer(midi);
        // const blob = new Blob([writer.buildFile()], {type: 'audio/midi'});
        // const url = URL.createObjectURL(blob);
        // const a = document.createElement('a');
        // a.href = url;
        // a.download = 'score.mid';
        // a.click();
        // URL.revokeObjectURL(url);
    },

    saveExercise: function() {
        const exerciseData = JSON.stringify(this.state.scoreData);
        const blob = new Blob([exerciseData], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'music_exercise.json';
        a.click();
        URL.revokeObjectURL(url);
    }
};

// Initialize the editor when the page loads
document.addEventListener('DOMContentLoaded', function() {
    scoreEditor.init({
        containerId: 'output',
        enableAssessment: true,
        enableVoiceSelection: true
    });
});