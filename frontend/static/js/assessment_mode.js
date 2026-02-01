class AssessmentMode {
    constructor(scoreData, options = {}) {
        this.scoreData = scoreData;
        this.pitchDetector = null;
        this.isRunning = false;
        
        this.exerciseNotes = this.extractExerciseNotes();
        this.currentNoteIndex = 0;
        this.correctNotes = 0;
        this.totalNotes = this.exerciseNotes.length;
        
        // UI elements
        this.startBtn = options.startBtn || document.getElementById('start-assessment');
        this.resultsDiv = options.resultsDiv || document.getElementById('assessment-results');
        this.accuracyBar = options.accuracyBar || document.getElementById('pitch-accuracy');
        this.accuracyValue = options.accuracyValue || document.getElementById('accuracy-value');
        
        // Callbacks
        this.onNoteMatch = options.onNoteMatch || (() => {});
        this.onComplete = options.onComplete || (() => {});
        
        this.bindEvents();
    }
    
    bindEvents() {
        if (this.startBtn) {
            this.startBtn.addEventListener('click', () => {
                if (!this.isRunning) {
                    this.start();
                } else {
                    this.stop();
                }
            });
        }
    }
    
    extractExerciseNotes() {
        const notes = [];
        if (this.scoreData && this.scoreData.measures) {
            this.scoreData.measures.forEach(measure => {
                if (measure.notes) {
                    measure.notes.forEach(note => {
                        const noteInfo = this.parseVexFlowKey(note.key);
                        notes.push({
                            name: noteInfo.name,        // e.g., "C"
                            octave: noteInfo.octave,    // e.g., 4
                            fullName: noteInfo.fullName, // e.g., "C4"
                            midiNote: note.midiNote,
                            originalKey: note.key
                        });
                    });
                }
            });
        }
        return notes;
    }
    
    parseVexFlowKey(key) {
        // Parse VexFlow key format (e.g., "c/4", "c#/4")
        const parts = key.split('/');
        let noteName = parts[0].toUpperCase();
        const octave = parseInt(parts[1]);
        
        // Normalize flats to sharps for comparison with PitchDetector
        if (noteName.length > 1 && noteName.includes('B')) { // Handle flat like "CB" or "EB" -> usually comes as "Eb"
            // Simple mapping for common flats if they appear in VexFlow keys
             const flatMap = {'DB':'C#', 'EB':'D#', 'GB':'F#', 'AB':'G#', 'BB':'A#'};
             if (flatMap[noteName]) noteName = flatMap[noteName];
        }

        // Standardize Name
        // Note: PitchDetector returns "C#", VexFlow might use "C#" or "DB"
        // Ideally rely on MIDI note comparison if available, but string matching works if normalized.
        
        return {
            name: noteName,
            octave: octave,
            fullName: noteName + octave
        };
    }
    
    async start() {
        if (this.totalNotes === 0) {
            alert('No notes found in the exercise!');
            return;
        }
        
        this.pitchDetector = new PitchDetector({
            onNoteDetected: (noteInfo) => this.handleNoteDetected(noteInfo),
            onError: (error) => {
                console.error('Pitch detection error:', error);
                alert('Error with microphone: ' + error);
                this.stop();
            }
        });
        
        const initialized = await this.pitchDetector.initialize();
        if (!initialized) return;
        
        this.currentNoteIndex = 0;
        this.correctNotes = 0;
        this.updateAccuracy();
        
        this.isRunning = true;
        this.startBtn.textContent = 'Stop Assessment';
        this.startBtn.classList.remove('btn-success');
        this.startBtn.classList.add('btn-danger');
        this.resultsDiv.style.display = 'block';
        
        this.highlightCurrentNote();
        this.pitchDetector.start();
    }
    
    stop() {
        if (this.pitchDetector) {
            this.pitchDetector.stop();
            this.pitchDetector = null;
        }
        
        this.isRunning = false;
        this.startBtn.textContent = 'Start Assessment';
        this.startBtn.classList.remove('btn-danger');
        this.startBtn.classList.add('btn-success');
        this.clearAllHighlights();
    }
    
    handleNoteDetected(noteInfo) {
        // noteInfo comes from PitchDetector (e.g., {name: "C4", cents: 5...})
        if (!noteInfo || noteInfo.name === '--' || this.currentNoteIndex >= this.totalNotes) {
            return;
        }
        
        const expectedNote = this.exerciseNotes[this.currentNoteIndex];
        
        // Strict Match: Compare Full Name (Note + Octave)
        if (this.notesMatch(noteInfo, expectedNote)) {
            this.correctNotes++;
            this.currentNoteIndex++;
            this.updateAccuracy();
            this.onNoteMatch(expectedNote, noteInfo);
            
            if (this.currentNoteIndex >= this.totalNotes) {
                this.completeAssessment();
            } else {
                this.highlightCurrentNote();
            }
        }
    }
    
    notesMatch(detectedNote, expectedNote) {
        // Enforce Octave Matching
        // detectedNote.name is "C4", expectedNote.fullName is "C4"
        return detectedNote.name === expectedNote.fullName;
    }
    
    updateAccuracy() {
        const accuracy = this.totalNotes > 0 
            ? Math.round((this.correctNotes / this.totalNotes) * 100) 
            : 0;
        
        this.accuracyBar.style.width = accuracy + '%';
        this.accuracyValue.textContent = accuracy + '%';
        this.accuracyBar.classList.remove('bg-success', 'bg-warning', 'bg-danger');
        
        if (accuracy >= 80) this.accuracyBar.classList.add('bg-success');
        else if (accuracy >= 60) this.accuracyBar.classList.add('bg-warning');
        else this.accuracyBar.classList.add('bg-danger');
    }
    
    highlightCurrentNote() {
        this.clearAllHighlights();
        if (this.currentNoteIndex >= this.totalNotes) return;
        
        // This relies on VexFlow DOM elements having specific IDs or classes
        // The HTML integration must ensure these exist.
        // Assuming the detail.html implementation handles the visual highlighting
        // via the callback or shared state, but we can emit an event here.
    }
    
    clearAllHighlights() {
        // Handled in UI layer usually, or generic class removal
        const notes = document.querySelectorAll('.assessment-highlight');
        notes.forEach(n => n.classList.remove('assessment-highlight'));
    }
    
    completeAssessment() {
        this.stop();
        const finalAccuracy = Math.round((this.correctNotes / this.totalNotes) * 100);
        alert(`Assessment Complete!\nCorrect: ${this.correctNotes}/${this.totalNotes}\nAccuracy: ${finalAccuracy}%`);
        this.onComplete(finalAccuracy, this.correctNotes, this.totalNotes);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AssessmentMode;
}