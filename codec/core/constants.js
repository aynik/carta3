/**
 * Carta3 Audio Codec - Core Constants
 */

// ATRAC3 stream geometry.
/** Sample rate. */
export const SAMPLE_RATE = 44100
/** Frame samples. */
export const FRAME_SAMPLES = 1024
/** Samples in one half-frame transform window. */
export const HALF_FRAME_SAMPLES = FRAME_SAMPLES / 2
/** Samples in one of the four transform subbands. */
export const SUBBAND_SAMPLES = FRAME_SAMPLES / 4
/** Channels. */
export const CHANNELS = 2
/** Max channels. */
export const MAX_CHANNELS = 2
/** Residual delay samples. */
export const RESIDUAL_DELAY_SAMPLES = 138
/** Decoder max units. */
export const DECODER_MAX_UNITS = 4
/** Decoder spectral lines per unit. */
export const DECODER_SPECTRAL_LINES_PER_UNIT = 256
/** Decoder spectrum floats per unit. */
export const DECODER_SPECTRUM_FLOATS_PER_UNIT = 128
/** Offset of fractional gain factors in the inverse scale table. */
export const INVERSE_GAIN_FRACTIONAL_SCALE_OFFSET = 16
/** Analysis work floats. */
export const ANALYSIS_WORK_FLOATS = 0x5228 / 4
/** Spectrum work floats. */
export const SPECTRUM_WORK_FLOATS = 0x800
/** Reusable bitstream over-read padding. */
export const BITSTREAM_PADDING_BYTES = 16
/** Largest maintained encoded frame. */
export const MAX_CODED_FRAME_BYTES = 384
/** Allocation work words. */
export const ALLOCATION_WORK_WORDS = 0x800
/** Spectrum groups. */
export const SPECTRUM_GROUPS = 32

/** 132 kbps sound-unit allocation geometry. */
export const INITIAL_132_SPECTRUM_GROUPS = 29
/** Initial 132 component groups. */
export const INITIAL_132_COMPONENT_GROUPS = 3
/** Allocation band count. */
export const ALLOCATION_BAND_COUNT = 32
/** Largest coefficient span owned by one quantization band. */
export const MAX_QUANTIZATION_BAND_COEFFICIENTS = 128
/** Candidate transitions retained per band during sound-unit water filling. */
export const SOUND_UNIT_FILL_MOVES_PER_BAND = 2
/** Water-fill transition that raises spectral word length. */
export const SOUND_UNIT_FILL_RAISE_WORD_LENGTH = 0
/** Water-fill transition that lowers the time-domain dead-zone factor. */
export const SOUND_UNIT_FILL_LOWER_TIME_FACTOR = 1
/** Word length limit. */
export const WORD_LENGTH_LIMIT = 7
/** Largest six-bit spectral scale-factor index. */
export const SCALE_FACTOR_INDEX_MAX = 0x3f
/** Largest coded residual quantization mode. */
export const RESIDUAL_MODE_MAX = 7
/** Per-band mode bits in a spectrum allocation header. */
export const SPECTRUM_ALLOCATION_BITS_PER_BAND = 3

/** Shared low-rate allocation word-image geometry. */
export const ALLOCATION_MODES_OFFSET = 0x00
/** Allocation scale factor offset. */
export const ALLOCATION_SCALE_FACTOR_OFFSET = 0x20
/** Allocation active bands word. */
export const ALLOCATION_ACTIVE_BANDS_WORD = 0x40
/** Allocation block count word. */
export const ALLOCATION_BLOCK_COUNT_WORD = 0x41
/** Allocation tone mode word. */
export const ALLOCATION_TONE_MODE_WORD = 0x42
/** Allocation tone region count word. */
export const ALLOCATION_TONE_REGION_COUNT_WORD = 0x43
/** Allocation tone regions offset. */
export const ALLOCATION_TONE_REGIONS_OFFSET = 0x44
/** Allocation tone region words. */
export const ALLOCATION_TONE_REGION_WORDS = 0x86
/** Allocation residual spectrum offset. */
export const ALLOCATION_RESIDUAL_SPECTRUM_OFFSET = 0x31d
/** Allocation residual spectrum count. */
export const ALLOCATION_RESIDUAL_SPECTRUM_COUNT = 0x400

/** Gain-control syntax and interpolation geometry. */
export const GAIN_SLOT_COUNT = 7
/** Gain level default. */
export const GAIN_LEVEL_DEFAULT = 7
/** Gain level max. */
export const GAIN_LEVEL_MAX = 0x0f
/** Gain location max. */
export const GAIN_LOCATION_MAX = 0x1f
/** Gain step count. */
export const GAIN_STEP_COUNT = 64
/** Gain samples per step. */
export const GAIN_SAMPLES_PER_STEP = 8
/** Gain scale samples. */
export const GAIN_SCALE_SAMPLES = 512
/** Neutral gain level used by the low-rate layered kernel. */
export const LAYER_GAIN_NEUTRAL_LEVEL = 4
/** Word offset of copied magnitudes in layered gain scratch. */
export const LAYER_GAIN_SCRATCH_HISTORY_OFFSET = 0x0c
/** Number of four-sample magnitude groups inspected per pair block. */
export const LAYER_GAIN_GROUP_COUNT = 8
/** Samples represented by one layered magnitude group. */
export const LAYER_GAIN_GROUP_SAMPLES = 4
/** Gain-step budget initially available to layered release detection. */
export const LAYER_GAIN_RELEASE_BUDGET = 4

/** Four-band QMF and MDCT storage geometry. */
export const SUBBAND_COUNT = 4
/** Band part floats. */
export const BAND_PART_FLOATS = 256
/** Band stride floats. */
export const BAND_STRIDE_FLOATS = 768
/** Qmf taps. */
export const QMF_TAPS = 48
/** Qmf delay. */
export const QMF_DELAY = 46
/** Root history offset. */
export const ROOT_HISTORY_OFFSET = 0x5000 / 4
/** Low history offset. */
export const LOW_HISTORY_OFFSET = 0x50b8 / 4
/** High history offset. */
export const HIGH_HISTORY_OFFSET = 0x5170 / 4
/** Layered qmf history floats. */
export const LAYERED_QMF_HISTORY_FLOATS = 138
/** Low-rate QMF first-stage interleaved delay offset. */
export const LAYERED_QMF_STAGE_OFFSET = 0x5c
/** Low-rate QMF second-stage convolution cursor offset. */
export const LAYERED_QMF_CONVOLUTION_CURSOR_OFFSET = 0x58
/** Last direct-analysis QMF curve index. */
export const LAYERED_QMF_ANALYSIS_TAIL_INDEX = 0x16
/** Direct-analysis QMF mirror origin. */
export const LAYERED_QMF_ANALYSIS_MIRROR_INDEX = 0x17
/** Low-rate synthesis QMF history cursor offset. */
export const LAYERED_QMF_SYNTHESIS_CURSOR_OFFSET = 0x54
/** Last low-rate synthesis QMF tap. */
export const LAYERED_QMF_SYNTHESIS_LAST_TAP = 0x15
/** Low-rate synthesis QMF mirror origin. */
export const LAYERED_QMF_SYNTHESIS_MIRROR_INDEX = 0x16
/** Low-rate synthesis carry-lane offset. */
export const LAYERED_QMF_SYNTHESIS_CARRY_OFFSET = 0x2e
/** Low-rate synthesis history-lane offset from its cursor. */
export const LAYERED_QMF_SYNTHESIS_HISTORY_OFFSET = 0x32
/** Transform carry offset floats. */
export const TRANSFORM_CARRY_OFFSET_FLOATS =
  SUBBAND_COUNT * 3 * BAND_PART_FLOATS
/** Forward transform carry offset. */
export const FORWARD_TRANSFORM_CARRY_OFFSET = 0x4000 / 4
/** Mdct normalization scale. */
export const MDCT_NORMALIZATION_SCALE = 0.0078125

/** Low-rate layer word-image geometry. */
export const PAIR_BLOCK_WORDS = 51
/** Pair block base word. */
export const PAIR_BLOCK_BASE_WORD = 0x0a8a
/** Pair block gain count word. */
export const PAIR_BLOCK_GAIN_COUNT_WORD = 0x32
/** Pair block gain level offset. */
export const PAIR_BLOCK_GAIN_LEVEL_OFFSET = 8
/** Pair block gain slots. */
export const PAIR_BLOCK_GAIN_SLOTS = 7
/** Pair block magnitude history offset. */
export const PAIR_BLOCK_MAGNITUDE_HISTORY_OFFSET = 0x10
/** Pair block magnitude history words. */
export const PAIR_BLOCK_MAGNITUDE_HISTORY_WORDS = 0x20
/** Pair block maximum magnitude word. */
export const PAIR_BLOCK_MAXIMUM_MAGNITUDE_WORD = 0x30
/** Pair block last group maximum word. */
export const PAIR_BLOCK_LAST_GROUP_MAXIMUM_WORD = 0x31
/** Tone history word. */
export const TONE_HISTORY_WORD = 0x0b56
/** Transform matrix base word. */
export const TRANSFORM_MATRIX_BASE_WORD = 0x400
/** Layer words. */
export const LAYER_WORDS = 0x0b5a
/** Words in each layered matrix/history region. */
export const LAYER_MATRIX_WORDS = HALF_FRAME_SAMPLES
/** Detached layered gain-analysis scratch words. */
export const LAYER_GAIN_SCRATCH_WORDS = 0xac
/** Words between layered gain-control rows. */
export const LAYER_GAIN_ROW_WORDS = 0x20
/** Layered window-matrix word offset. */
export const LAYER_WINDOW_MATRIX_OFFSET = 0x400
/** Layered gain-history word offset. */
export const LAYER_GAIN_HISTORY_OFFSET = 0x600
/** Layered transform-history word offset. */
export const LAYER_TRANSFORM_HISTORY_OFFSET = 0x800
/** Layered QMF-history word offset. */
export const LAYER_QMF_HISTORY_OFFSET = 0x0a00
/** Layered scale-factor band-limit word. */
export const LAYER_SCALE_FACTOR_BAND_LIMIT_WORD = 0x0b57
/** Layered residual bit-budget word. */
export const LAYER_BIT_BUDGET_WORD = 0x0b58
/** Layered stereo-mode word. */
export const LAYER_STEREO_FLAG_WORD = 0x0b59
/** Primary low-rate channel header cost in bits. */
export const LAYER_PRIMARY_HEADER_BITS = 0x13
/** Secondary low-rate channel header cost in bits. */
export const LAYER_SECONDARY_HEADER_BITS = 0x1b
/** Rounding added when converting a coefficient limit to joint-stereo slots. */
export const JOINT_STEREO_SLOT_ROUNDING = SUBBAND_SAMPLES - 1
/** Four-bit selector enabling every joint-stereo slot. */
export const JOINT_STEREO_ALL_SLOTS = (1 << SUBBAND_COUNT) - 1

/** Decoder state and work-image geometry. */
export const DECODER_UNIT_MODE_DEFAULT = 4
/** Decoder pair entries. */
export const DECODER_PAIR_ENTRIES = 8
/** Decoder work floats. */
export const DECODER_WORK_FLOATS = FRAME_SAMPLES + RESIDUAL_DELAY_SAMPLES

/** WAVE container constants. */
export const PCM_WAVE_HEADER_BYTES = 44
/** Pcm wave bits per sample. */
export const PCM_WAVE_BITS_PER_SAMPLE = 16
/** Wave format tag. */
export const WAVE_FORMAT_TAG = 0x0270
/** Wave header bytes. */
export const WAVE_HEADER_BYTES = 80
/** Wave delay samples. */
export const WAVE_DELAY_SAMPLES = 69
/** Channel sync. */
export const CHANNEL_SYNC = 0x28

/** Encoder policy identifiers. */
export const TONE_POLICY_THRESHOLD = 'above-average-threshold'
/** Tone policy none. */
export const TONE_POLICY_NONE = 'none'

/** 132 kbps allocation-search tuning. */
export const TUNE_SCALE = 256
/** Tune initial step. */
export const TUNE_INITIAL_STEP = 2 * TUNE_SCALE
/** Tune min exclusive. */
export const TUNE_MIN_EXCLUSIVE = -64 * TUNE_SCALE
/** Tune max exclusive. */
export const TUNE_MAX_EXCLUSIVE = 64 * TUNE_SCALE
/** Tune refinement steps. */
export const TUNE_REFINEMENT_STEPS = 8

/** Residual quantizer and search constants. */
export const CODEBOOK_ZERO_SCALE_BITS = 0x0005f800
/** Float rounding bias. */
export const FLOAT_ROUNDING_BIAS = 12582912
/** IEEE-754 binary32 exponent field shift. */
export const FLOAT32_EXPONENT_SHIFT = 23
/** IEEE-754 binary32 exponent field mask. */
export const FLOAT32_EXPONENT_MASK = 0xff
/** IEEE-754 binary32 exponent bias. */
export const FLOAT32_EXPONENT_BIAS = 0x7f
/** IEEE-754 binary32 negative-zero word. */
export const FLOAT32_NEGATIVE_ZERO_BITS = 0x80000000
/** Residual search done. */
export const RESIDUAL_SEARCH_DONE = -1
/** Min shift. */
export const MIN_SHIFT = 0x20
/** Split explore span. */
export const SPLIT_EXPLORE_SPAN = 64
/** Quantization limit bias. */
export const QUANTIZATION_LIMIT_BIAS = 0.5
/** Quantization bias scale. */
export const QUANTIZATION_BIAS_SCALE = 31.5

/** Tone-search syntax costs and fixed selections. */
export const TONE_POOL_MAX_INDEX = 63
/** Tone group list bits. */
export const TONE_GROUP_LIST_BITS = 12
/** Tone component side bits. */
export const TONE_COMPONENT_SIDE_BITS = 12
/** Tone entry header bits. */
export const TONE_ENTRY_HEADER_BITS = 6
/** Tone descriptor. */
export const TONE_DESCRIPTOR = 3
/** Tone word length. */
export const TONE_WORD_LENGTH = 7
/** Tone table set. */
export const TONE_TABLE_SET = 1

/** Gain-analysis candidate geometry. */
export const ATTACK_CANDIDATE_COUNT = 32
/** Release candidate count. */
export const RELEASE_CANDIDATE_COUNT = 8
/** Gain candidate count. */
export const GAIN_CANDIDATE_COUNT =
  ATTACK_CANDIDATE_COUNT + RELEASE_CANDIDATE_COUNT
/** Max selected gain candidates. */
export const MAX_SELECTED_GAIN_CANDIDATES = 7
/** Log2 e f32. */
export const LOG2_E_F32 = Math.fround(Math.LOG2E)

/** Exact floating-point sentinels used by the layered transform. */
export const GAIN_MAGNITUDE_SENTINEL_BITS = 0x508b771f
/** Breakpoint magnitude floor bits. */
export const BREAKPOINT_MAGNITUDE_FLOOR_BITS = 0x512e54e6
/** Square root two bits. */
export const SQUARE_ROOT_TWO_BITS = 0x3fb504f3
/** Gain budget scale bits. */
export const GAIN_BUDGET_SCALE_BITS = 0x27eaf459
/** Breakpoint snap ratio bits. */
export const BREAKPOINT_SNAP_RATIO_BITS = 0x3feccccd
/** Inverse square root two bits. */
export const INVERSE_SQUARE_ROOT_TWO_BITS = 0x3f3504f3
/** Seed magnitude limit. */
export const SEED_MAGNITUDE_LIMIT = 7.667187e13

/** Exact joint-stereo ratio constants stored by IEEE-754 bit pattern. */
export const INTERPOLATION_STEP_BITS = 1040187392
/** Unity bits. */
export const UNITY_BITS = 1065353216
/** Half bits. */
export const HALF_BITS = 1056964608
/** Fallback ratio bits. */
export const FALLBACK_RATIO_BITS = 1070945621
/** Max ratio step bits. */
export const MAX_RATIO_STEP_BITS = 4587366580439587226n
/** Lower ratio bound bits. */
export const LOWER_RATIO_BOUND_BITS = 4616054510065937285n
/** Upper ratio bound bits. */
export const UPPER_RATIO_BOUND_BITS = 1132462080
/** Ratio mapping scale bits. */
export const RATIO_MAPPING_SCALE_BITS = 1071059752

/** Smallest positive normal binary64 value used by masking. */
export const F64_MIN_POSITIVE = 2.2250738585072014e-308
