/** Carta3 Audio Codec - Promise-based Web Worker client. */

export class Carta3Worker {
  /**
   * Create a worker client and install job-resolution handlers.
   *
   * @param {string|URL} [workerPath] Worker bundle location.
   */
  constructor(workerPath = 'carta3-worker.min.js') {
    this.worker = new Worker(workerPath)
    this.nextJobId = 1
    this.jobs = new Map()
    /**
     * Handle onmessage.
     *
     * @param {object} event
     */
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.jobId)
      if (!job) return
      this.jobs.delete(data.jobId)
      if (data.error) job.reject(new Error(data.error))
      else job.resolve(data.result)
    }
    /**
     * Handle onerror.
     *
     * @param {Error|Event} error
     */
    this.worker.onerror = (error) => {
      for (const { reject } of this.jobs.values()) reject(error)
      this.jobs.clear()
    }
  }

  /**
   * Submit one typed worker request and resolve its correlated response.
   *
   * @param {string} type Worker operation identifier.
   * @param {object} [payload] Structured-cloneable operation payload.
   * @returns {Promise<object|object[]>} Correlated worker result.
   */
  request(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('Worker is terminated'))
    const jobId = this.nextJobId++
    return new Promise((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject })
      this.worker.postMessage({ jobId, type, ...payload })
    })
  }

  /**
   * Encode planar PCM into an ATRAC3 WAVE blob.
   *
   * @param {Float32Array[]} pcmData Planar stereo PCM.
   * @param {object} [options] Encoder profile options.
   * @returns {Promise<{waveBlob: Blob, info: object}>} Encoded blob and metadata.
   */
  encode(pcmData, options = {}) {
    return this.request('encode', { pcmData, options })
  }

  /**
   * Decode an ATRAC3 WAVE image into a PCM WAVE blob.
   *
   * @param {ArrayBuffer|ArrayBufferView|Blob} wave Encoded WAVE input.
   * @returns {Promise<{wavBlob: Blob, info: object}>} Decoded blob and metadata.
   */
  decode(wave) {
    return this.request('decode', { wave })
  }

  /**
   * Read container and profile metadata without decoding samples.
   *
   * @param {ArrayBuffer|ArrayBufferView|Blob} wave Encoded WAVE input.
   * @returns {Promise<object>} Container and ATRAC3 profile metadata.
   */
  inspect(wave) {
    return this.request('inspect', { wave })
  }

  /**
   * Return codec profiles supported by the worker build.
   *
   * @returns {Promise<object[]>} Maintained profile descriptors.
   */
  getProfiles() {
    return this.request('getProfiles')
  }

  /**
   * Terminate the worker and reject every outstanding request.
   *
   * @returns {void}
   */
  terminate() {
    if (!this.worker) return
    this.worker.terminate()
    this.worker = null
    for (const { reject } of this.jobs.values()) {
      reject(new Error('Worker is terminated'))
    }
    this.jobs.clear()
  }
}

export default Carta3Worker
