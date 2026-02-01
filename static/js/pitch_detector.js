// pitch_detector.js
// High-Accuracy Pitch Detection Module using YIN Algorithm
// Derived from index6.html logic

class PitchDetector {
    constructor(options = {}) {
        // Configuration
        this.A4 = options.A4 || 440;
        this.notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        
        // Audio processing parameters
        this.sampleRate = 44100; // Will be set by context
        this.fftSize = options.fftSize || 8192; // High resolution
        this.windowSize = options.windowSize || 4096;
        
        // Algorithm parameters
        this.minFreq = options.minFreq || 80;   // ~E2
        this.maxFreq = options.maxFreq || 1200; // ~D6
        this.sensitivity = options.sensitivity || 0.3;
        this.smoothingFactor = options.smoothing || 0.7;
        
        // Note stability parameters
        this.NOTE_CONFIDENCE_THRESHOLD = 0.6; // Lower threshold for YIN
        this.NOTE_STABILITY_PITCH_THRESHOLD = 0.5; // semitones
        this.NOTE_BUFFER_SIZE = 6; // Frames needed for stable note (faster response)
        
        // State
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.mediaStream = null;
        this.isRunning = false;
        
        // Processing arrays
        this.bufferLength = 0;
        this.frequencyData = null;
        this.timeData = null;
        this.processedTimeData = null;
        this.hannWindow = null;
        
        // History tracking
        this.smoothedPitchHistory = [];
        this.noteBuffer = [];
        this.lastStableNote = { name: '--', confidence: 0, frequency: 0 };
        
        // Callbacks
        this.onNoteDetected = options.onNoteDetected || (() => {});
        this.onError = options.onError || ((error) => console.error(error));
    }
    
    async initialize() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false
                } 
            });
            
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.sampleRate = this.audioContext.sampleRate;
            
            // Create analyser with high FFT size for accuracy
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = this.fftSize;
            this.analyser.smoothingTimeConstant = 0;
            
            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.mediaStream = stream;
            
            // Filters to reduce noise
            const highPass = this.audioContext.createBiquadFilter();
            highPass.type = 'highpass';
            highPass.frequency.value = this.minFreq * 0.75;

            const lowPass = this.audioContext.createBiquadFilter();
            lowPass.type = 'lowpass';
            lowPass.frequency.value = this.maxFreq * 1.25;

            this.microphone.connect(highPass).connect(lowPass).connect(this.analyser);
            
            // Initialize buffers
            this.bufferLength = this.analyser.frequencyBinCount;
            this.frequencyData = new Float32Array(this.bufferLength);
            this.timeData = new Float32Array(this.fftSize);
            this.processedTimeData = new Float32Array(this.windowSize);
            
            // Create Hann window
            this.hannWindow = new Float32Array(this.windowSize);
            for (let i = 0; i < this.windowSize; i++) {
                this.hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.windowSize - 1)));
            }
            
            return true;
        } catch (error) {
            this.onError('Failed to initialize audio: ' + error.message);
            return false;
        }
    }
    
    start() {
        if (!this.audioContext) {
            this.onError('Pitch detector not initialized.');
            return;
        }
        this.isRunning = true;
        this.analyze();
    }
    
    stop() {
        this.isRunning = false;
        
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().then(() => {
                this.audioContext = null;
            });
        }
        
        this.lastStableNote = { name: '--', confidence: 0, frequency: 0 };
        this.noteBuffer = [];
        this.smoothedPitchHistory = [];
    }
    
    analyze() {
        if (!this.isRunning) return;
        
        this.analyser.getFloatFrequencyData(this.frequencyData);
        this.analyser.getFloatTimeDomainData(this.timeData);
        
        // 1. Preprocess (Windowing)
        this.preprocessAudio();
        
        // 2. YIN Algorithm (High Precision)
        const yinPitch = this.yinPitchDetection(this.processedTimeData);
        
        // 3. Smoothing
        const smoothedPitch = this.applySmoothingFilter(yinPitch);
        this.updateHistories(smoothedPitch);
        
        // 4. Note quantization and Stability Check
        this.decideOnNote(smoothedPitch);
        
        requestAnimationFrame(() => this.analyze());
    }
    
    preprocessAudio() {
        // Center the window in the buffer
        const startIdx = Math.floor((this.fftSize - this.windowSize) / 2);
        for (let i = 0; i < this.windowSize; i++) {
            this.processedTimeData[i] = this.timeData[startIdx + i] * this.hannWindow[i];
        }
    }
    
    // Adapted from index6.html - Superior to autocorrelation
    yinPitchDetection(signal) {
        const minPeriod = Math.floor(this.sampleRate / this.maxFreq);
        const maxPeriod = Math.floor(this.sampleRate / this.minFreq);
        const threshold = 0.15; // Slightly relaxed threshold
        
        if (maxPeriod >= signal.length) return { frequency: 0, confidence: 0 };
        
        // Difference function
        const differenceFunction = new Float32Array(maxPeriod);
        let runningSum = 0;
        
        for (let tau = 1; tau < maxPeriod; tau++) {
            let sum = 0;
            for (let i = 0; i < signal.length - tau; i++) {
                const diff = signal[i] - signal[i + tau];
                sum += diff * diff;
            }
            runningSum += sum;
            // Cumulative Mean Normalized Difference
            differenceFunction[tau] = sum / ((runningSum / tau) + 1e-6);
        }
        
        // Absolute Thresholding
        let period = 0;
        for (let tau = minPeriod; tau < maxPeriod; tau++) {
            if (differenceFunction[tau] < threshold) {
                // Find local minimum
                while (tau + 1 < maxPeriod && differenceFunction[tau + 1] < differenceFunction[tau]) {
                    tau++;
                }
                period = tau;
                break;
            }
        }
        
        // Fallback to global minimum if no threshold match
        if (period === 0) {
            let minVal = Infinity;
            for (let tau = minPeriod; tau < maxPeriod; tau++) {
                if (differenceFunction[tau] < minVal) {
                    minVal = differenceFunction[tau];
                    period = tau;
                }
            }
        }

        if (period === 0) return { frequency: 0, confidence: 0 };
        
        // Parabolic Interpolation for sub-sample accuracy
        let betterTau = period;
        let confidence = 1 - differenceFunction[period];
        
        if (period > 1 && period < maxPeriod - 1) {
            const y0 = differenceFunction[period - 1];
            const y1 = differenceFunction[period];
            const y2 = differenceFunction[period + 1];
            const p = (y2 - y0) / (2 * (2 * y1 - y2 - y0));
            if (!isNaN(p) && Math.abs(p) < 1) {
                betterTau += p;
            }
        }
        
        return { 
            frequency: this.sampleRate / betterTau, 
            confidence: Math.max(0, confidence) 
        };
    }
    
    applySmoothingFilter(pitchResult) {
        if (this.smoothedPitchHistory.length === 0) return pitchResult;
        
        const lastSmoothedPitch = this.smoothedPitchHistory[this.smoothedPitchHistory.length - 1].frequency;
        
        // Only smooth if frequencies are relatively close (prevents sliding between distant notes)
        if (Math.abs(lastSmoothedPitch - pitchResult.frequency) > 50) {
            return pitchResult;
        }

        const smoothedFreq = (this.smoothingFactor * lastSmoothedPitch) + 
                            ((1 - this.smoothingFactor) * pitchResult.frequency);
        
        return { frequency: smoothedFreq, confidence: pitchResult.confidence };
    }
    
    updateHistories(smoothedPitchResult) {
        this.smoothedPitchHistory.push(smoothedPitchResult);
        if (this.smoothedPitchHistory.length > 5) { // Keep history short
            this.smoothedPitchHistory.shift();
        }
    }
    
    decideOnNote(pitchResult) {
        const level = this.calculateSignalLevel();
        
        if (pitchResult.confidence > this.NOTE_CONFIDENCE_THRESHOLD && level > -60) {
            // Get raw note data
            const noteInfo = this.frequencyToNote(pitchResult.frequency);
            const currentReading = { ...noteInfo, frequency: pitchResult.frequency };
            
            // This allows the UI to show what's currently being sung even if not fully "locked" yet
            this.lastStableNote = { 
                name: currentReading.name, 
                confidence: pitchResult.confidence,
                frequency: pitchResult.frequency,
                cents: currentReading.cents
            };
            
            // Buffer logic for Stability
            if (this.noteBuffer.length > 0) {
                const lastNote = this.noteBuffer[this.noteBuffer.length - 1];
                const pitchDistance = Math.abs(12 * Math.log2(currentReading.frequency / lastNote.frequency));
                
                if (pitchDistance < this.NOTE_STABILITY_PITCH_THRESHOLD) {
                    this.noteBuffer.push(currentReading);
                } else {
                    this.noteBuffer = [currentReading];
                }
            } else {
                this.noteBuffer.push(currentReading);
            }
        } else {
            this.noteBuffer = [];
            // Send a "silence" update periodically to clear UI
            if (this.lastStableNote.name !== '--') {
                this.lastStableNote = { name: '--', confidence: 0, frequency: 0 };
                this.onNoteDetected(this.lastStableNote); 
            }
        }
        
        // If enough stable frames, emit "Locked" Note
        if (this.noteBuffer.length >= this.NOTE_BUFFER_SIZE) {
            // Find most frequent note name in buffer (Mode)
            const noteNames = this.noteBuffer.map(n => n.name);
            const modeMap = {};
            let maxCount = 0, modeNoteName = noteNames[0];
            
            for (const name of noteNames) {
                modeMap[name] = (modeMap[name] || 0) + 1;
                if (modeMap[name] > maxCount) {
                    maxCount = modeMap[name];
                    modeNoteName = name;
                }
            }
            
            // Average the frequency of the mode notes for precision
            const matchingNotes = this.noteBuffer.filter(n => n.name === modeNoteName);
            const avgFreq = matchingNotes.reduce((sum, n) => sum + n.frequency, 0) / matchingNotes.length;
            
            const finalNoteInfo = this.frequencyToNote(avgFreq);
            finalNoteInfo.frequency = avgFreq;
            finalNoteInfo.confidence = 1; // It is locked
            
            this.onNoteDetected(finalNoteInfo);
            
            // Keep a small overlap for continuous notes
            this.noteBuffer = this.noteBuffer.slice(-2); 
        }
    }
    
    frequencyToNote(freq) {
        if (freq <= 0) return { name: '--', cents: 0, octave: 0 };
        
        // Standard A440 calculation
        // noteNum 0 corresponds to A4 (440) based on index6 logic
        // But standard MIDI: A4 is 69. 
        // We will return standard Scientific Pitch Notation (C4, A4)
        
        const noteNum = 12 * Math.log2(freq / this.A4);
        const roundedNoteNum = Math.round(noteNum);
        
        // Calculate cents deviation
        const cents = Math.round((noteNum - roundedNoteNum) * 100);
        
        // Note index (0 = A, 1 = A#, etc.) because we started from A4
        // We need to map this to C=0, C#=1 for standard array access
        // A is index 9 in [C, C#, D...]
        
        let noteIndex = (roundedNoteNum + 9) % 12;
        if (noteIndex < 0) noteIndex += 12;
        
        // Calculate Octave
        // A4 is 440. log2(440/440) = 0. roundedNoteNum = 0.
        // A4 corresponds to octave 4.
        // C4 is 9 semitones below A4. roundedNoteNum = -9.
        // floor((-9 + 9) / 12) + 4 = 4. 
        // C3 is 21 semitones below A4. roundedNoteNum = -21. 
        // floor((-21 + 9) / 12) + 4 = -1 + 4 = 3.
        
        const octave = Math.floor((roundedNoteNum + 9) / 12) + 4;
        const name = this.notes[noteIndex] + octave;
        
        return { 
            name: name, // e.g., "C4", "F#5"
            cents: cents,
            octave: octave,
            noteIndex: noteIndex
        };
    }
    
    calculateSignalLevel() {
        let sum = 0;
        for (let i = 0; i < this.timeData.length; i++) {
            sum += this.timeData[i] * this.timeData[i];
        }
        const rms = Math.sqrt(sum / this.timeData.length);
        if (rms === 0) return -100;
        return 20 * Math.log10(rms);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PitchDetector;
}